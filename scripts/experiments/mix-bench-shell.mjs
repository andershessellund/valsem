// ---------------------------------------------------------------------------
// mix-bench-shell — the intern-pool contenders of mix-bench.mjs inside an
// engine shell (SpiderMonkey's `js`), where mix-bench.mjs cannot run: no
// child processes, no event loop, no memory statistics.
//
//   pnpm build && node scripts/experiments/mix-bench-spidermonkey.mjs
//   (or directly: js -m scripts/experiments/mix-bench-shell.mjs -- shipped "churn 50k, no hits")
//
// What replaces the event loop: a batch is a job; between batches the shell's
// clearKeptObjects() ends the job for WeakRef purposes, gc() is the shell's
// own full collection, and drainJobQueue() runs what a collection queued —
// the registry pool's finalization callbacks (which reclaim inline here:
// there is no setImmediate to defer to), the shipped pool's sentinel (one
// inline slice per report, for the same reason). ns/op is the batches alone;
// "gc" is the time in those three calls. No memory column: the shell has none.
// ---------------------------------------------------------------------------
import { args } from '../../bench/shell-compat.mjs';

const BATCH = 5_000;
const SCENARIOS = {
  'churn 50k, no hits': { prefill: 50_000, gcEvery: 200_000, inserts: 2_000_000, hits: 0, w: 50_000 },
  'churn 50k, 4 hits/ins': { prefill: 50_000, gcEvery: 200_000, inserts: 1_000_000, hits: 4, w: 50_000 },
  'churn 1M, no hits': { prefill: 1_000_000, gcEvery: 200_000, inserts: 2_000_000, hits: 0, w: 1_000_000 },
  'churn 1M, 4 hits/ins': { prefill: 1_000_000, gcEvery: 200_000, inserts: 1_000_000, hits: 4, w: 1_000_000 },
  'grow to 2M, no deaths': { prefill: 0, gcEvery: 200_000, inserts: 2_000_000, hits: 0, w: 2_000_000 },
};

const [poolName, scenarioName] = args;
const sc = SCENARIOS[scenarioName];
if (sc === undefined) throw new Error(`unknown scenario ${scenarioName}`);
const mod = await import(poolName === 'fr' ? './fr-pool.mjs' : '../../dist/intern-pool.js');
const pool = mod.createInternPool();
const stats = () => mod._poolStats(pool);

const now = () => performance.now();
const collect = () => {
  clearKeptObjects();
  gc();
  drainJobQueue();
};

function fmix(k) {
  k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
  k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
  return (k ^ (k >>> 16)) | 0;
}
let nextKey = 1;
let wanted = 0;
const pred = (c) => c.k === wanted;
const live = [];
let rnd = 0x2545f491;
const rand = () => {
  rnd ^= rnd << 13;
  rnd ^= rnd >>> 17;
  rnd ^= rnd << 5;
  return rnd >>> 0;
};
function insert(targetW) {
  const k = nextKey++;
  const h = fmix(k);
  wanted = k;
  let v = pool.lookup(h, pred);
  if (v === undefined) v = pool.register({ k }, h);
  if (live.length < targetW) live.push(v);
  else live[rand() % live.length] = v;
}
function hit() {
  const m = live[rand() % live.length];
  wanted = m.k;
  if (pool.lookup(fmix(m.k), pred) !== m) throw new Error('lost a live member');
}

for (let i = 0; i < sc.prefill; i++) insert(sc.prefill);
for (let i = 0; i < 3; i++) collect();

let opsMs = 0;
let gcMs = 0;
let maxBatch = 0;
let ops = 0;
let sinceGc = 0;
if (live.length > sc.w) live.length = sc.w;
for (let done = 0; done < sc.inserts; done += BATCH) {
  const t0 = now();
  for (let i = 0; i < BATCH; i++) {
    insert(sc.w);
    for (let q = 0; q < sc.hits; q++) hit();
  }
  const dt = now() - t0;
  opsMs += dt;
  if (dt > maxBatch) maxBatch = dt;
  ops += BATCH * (1 + sc.hits);
  sinceGc += BATCH;
  if (sinceGc >= sc.gcEvery) {
    sinceGc = 0;
    const t1 = now();
    collect();
    gcMs += now() - t1;
  }
}
const stored = stats().slots;
for (let i = 0; i < 3; i++) collect();
console.log(JSON.stringify({ nsPerOp: (opsMs * 1e6) / ops, gcMs, maxBatch, stored, storedAfterSettle: stats().slots, live: live.length }));
