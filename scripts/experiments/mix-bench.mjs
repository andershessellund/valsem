// ---------------------------------------------------------------------------
// mix-bench — intern-pool indexes over mixes of inserts, lookup hits and deaths.
// The measurements behind D2 and D3.
//
// Contenders (same lookup(hash, predicate) / register(value, hash) interface):
//   shipped        dist/intern-pool.js as built: the semispace index
//   fr             fr-pool.mjs, the pool it replaced: 64 Map shards, WeakRef
//                  slots, one FinalizationRegistry, idle-time reclaim
//   semi K [opts]  the prototype the shipped index was developed as, kept so the
//                  rejected variants can be re-run. 64 lazy shards, one int32
//                  per slot (24 hash bits | 8-bit epoch) plus a refs array; K
//                  live copies per insert from `old` to `cur`, the dead are not
//                  copied; a WeakRef canary counts major GCs. Options:
//                    gateF  verify only when a 64-slot sample finds >= F dead
//                           (without it: a verifying lap after every collection)
//                    +hits  a lookup hit in `old` moves the entry to `cur`
//                    bN     spend the migration credit once every N inserts
//                  "semi 1 gate.5" is the shipped configuration.
//   null, wr       ablations: the harness alone, and the harness plus one
//                  retained WeakRef per insert
//
// Method. Every measurement is its own process. Major GCs are FORCED every G
// inserts, so every run of a scenario sees the same epochs (with natural GC
// timing the same configuration measured anywhere from 134 to 192 ns/op).
// Reported per scenario: ns per operation over the timed batches; time inside
// the forced GCs; time in the event-loop turns between batches (where
// finalization callbacks and an idle drain run); the slowest batch; entries
// still stored at the end; and heap + array buffers after a final collection.
// Forced GCs are atomic where natural ones are incremental, and one per 200k
// inserts over a million live entries is more often than V8 would choose —
// compare columns, do not read them as production latencies.
//
// Env: BATCH (inserts per job, default 5000), HOT (hits go to the first HOT
// live members, default all), PROF=<file> (CPU profile of the timed phase),
// RUNTIME=<binary> (run the measuring processes under it instead of this node:
// the pinned Bun, for JavaScriptCore — see bench/fetch-engines.mjs).
//
// Run: pnpm build && node scripts/experiments/mix-bench.mjs [rounds] [pool,pool,…]
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BATCH = Number(process.env.BATCH ?? 5_000);
const HOT = Number(process.env.HOT ?? 0);

const SCENARIOS = {
  // name: { prefill, phases: [{ inserts, hitsPerInsert, targetW }], gcEvery }
  'churn 50k, no hits': { prefill: 50_000, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 50_000 }] },
  'churn 50k, 4 hits/ins': { prefill: 50_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 4, w: 50_000 }] },
  'churn 1M, no hits': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 1_000_000 }] },
  'churn 1M, 4 hits/ins': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 4, w: 1_000_000 }] },
  'read-mostly 1M, 16 hits/ins': { prefill: 1_000_000, gcEvery: 50_000, phases: [{ inserts: 250_000, hits: 16, w: 1_000_000 }] },
  'grow to 2M, no deaths': { prefill: 0, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 2_000_000 }] },
  'collapse 1M→50k, then churn': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 1, w: 50_000 }] },
};

const POOLS = process.argv[3] && process.argv[2] !== 'child' ? process.argv[3].split(',') : ['fr', 'shipped'];

// --- the semispace pool -------------------------------------------------------

class Table {
  constructor(p, cleanedEpoch) {
    this.p = p;
    this.cap = 1 << p;
    this.mask = this.cap - 1;
    this.shift = 32 - p;
    this.M = new Int32Array(this.cap);
    this.R = new Array(this.cap).fill(undefined);
    this.used = 0;
    this.oM = null;
    this.oR = null;
    this.oCap = 0;
    this.oMask = 0;
    this.oShift = 0;
    this.cursor = 0;
    this.credit = 0;
    this.cleanedEpoch = cleanedEpoch;
    this.verify = true;
    this.pending = 0;
    this.batchN = 1;
  }
}

// theta > 0: a verifying (dereferencing) cycle runs only when a 64-slot sample
// finds at least that fraction dead; otherwise a GC is ignored, and growth is a
// plain copy that keeps every stamp.
// batch > 1: migration credit accumulates and is spent once every `batch`
// inserts to the shard (capped at 1/16 of the table, so a small shard cannot
// fill while it waits).
function makeSemiPool(K, hitMigrates, theta = 0, batch = 1) {
  const shards = new Array(64).fill(undefined);
  let canary = new WeakRef({});
  let epoch = 1;
  let ep8 = 1;
  let tick = 0;
  const st = { cycles: 0, forced: 0, byHit: 0, skipped: 0, derefLive: 0, derefDead: 0 };

  function place(t, word, r) {
    const M = t.M;
    const mask = t.mask;
    let i = (word & ~0xff) >>> t.shift;
    while (M[i] !== 0) i = (i + 1) & mask;
    M[i] = word;
    t.R[i] = r;
    t.used++;
  }

  // Survivor estimate: 64 occupied slots from a random start.
  function sample(t) {
    let live = 0;
    let seen = 0;
    let i = (Math.random() * t.cap) | 0;
    for (let g = 0; seen < 64 && g < 4096; g++, i = (i + 1) & t.mask) {
      const w = t.M[i];
      if (w === 0) continue;
      seen++;
      if ((w & 0xff) === ep8 || t.R[i].deref() !== undefined) live++;
    }
    return seen === 0 ? 1 : live / seen;
  }

  function start(t, f, verify) {
    t.verify = verify;
    t.pending = 0;
    const expected = t.used * Math.min(1, f + 0.1) * (1 + 1 / K) + 16;
    let p = 6;
    while ((1 << p) * 0.45 < expected) p++;
    t.oM = t.M;
    t.oR = t.R;
    t.oCap = t.cap;
    t.oMask = t.mask;
    t.oShift = t.shift;
    t.cursor = 0;
    t.cleanedEpoch = epoch;
    t.p = p;
    t.cap = 1 << p;
    t.mask = t.cap - 1;
    t.shift = 32 - p;
    t.M = new Int32Array(t.cap);
    t.R = new Array(t.cap).fill(undefined);
    t.used = 0;
    t.batchN = Math.max(1, Math.min(batch, t.cap >> 4));
    st.cycles++;
  }

  function migrate(t, budget, slots) {
    const oM = t.oM;
    const oR = t.oR;
    const oCap = t.oCap;
    let c = t.cursor;
    while (budget > 0 && slots-- > 0 && c < oCap) {
      const w = oM[c];
      if (w !== 0) {
        const r = oR[c];
        if (r !== undefined) {
          if (!t.verify || (w & 0xff) === ep8) {
            st.skipped++;
            place(t, w, r);
            budget--;
          } else if (r.deref() !== undefined) {
            st.derefLive++;
            place(t, (w & ~0xff) | ep8, r);
            budget--;
          } else st.derefDead++;
        }
      }
      c++;
    }
    t.cursor = c;
    if (c >= oCap) {
      t.oM = null;
      t.oR = null;
    }
  }

  // cur is filling before old has drained: the survivor sample was too low.
  // If the rest of old might not fit, move cur (stamps kept, no deref) into a
  // table sized for everything, then drain old into that.
  function forceFinish(t) {
    let rem = 0;
    for (let c = t.cursor; c < t.oCap; c++) if (t.oM[c] !== 0 && t.oR[c] !== undefined) rem++;
    const need = t.used + rem + 16;
    if (need > t.cap * 0.6) {
      const cM = t.M;
      const cR = t.R;
      const cCap = t.cap;
      let p = t.p;
      while ((1 << p) * 0.45 < need) p++;
      t.p = p;
      t.cap = 1 << p;
      t.mask = t.cap - 1;
      t.shift = 32 - p;
      t.M = new Int32Array(t.cap);
      t.R = new Array(t.cap).fill(undefined);
      t.used = 0;
      for (let i = 0; i < cCap; i++) if (cM[i] !== 0) place(t, cM[i], cR[i]);
    }
    migrate(t, t.oCap, t.oCap);
  }

  return {
    lookup(hash, predicate) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = shards[m >>> 26];
      if (t === undefined) return undefined;
      const tag = (m << 6) & ~0xff;
      const M = t.M;
      let i = tag >>> t.shift;
      for (;;) {
        const w = M[i];
        if (w === 0) break;
        if ((w & ~0xff) === tag) {
          const v = t.R[i].deref();
          if (v !== undefined && predicate(v)) {
            if ((w & 0xff) !== ep8) M[i] = tag | ep8;
            return v;
          }
        }
        i = (i + 1) & t.mask;
      }
      const oM = t.oM;
      if (oM !== null) {
        i = tag >>> t.oShift;
        for (;;) {
          const w = oM[i];
          if (w === 0) break;
          if ((w & ~0xff) === tag) {
            const r = t.oR[i];
            if (r !== undefined) {
              const v = r.deref();
              if (v !== undefined && predicate(v)) {
                if (hitMigrates && i >= t.cursor) {
                  t.oR[i] = undefined;
                  place(t, tag | ep8, r);
                  st.byHit++;
                } else if ((w & 0xff) !== ep8) oM[i] = tag | ep8;
                return v;
              }
            }
          }
          i = (i + 1) & t.oMask;
        }
      }
      return undefined;
    },
    register(value, hash) {
      if ((++tick & 63) === 0 && canary.deref() === undefined) {
        canary = new WeakRef({});
        epoch++;
        ep8 = ((epoch - 1) % 255) + 1;
      }
      const m = Math.imul(hash, 0x9e3779b1);
      const s = m >>> 26;
      let t = shards[s];
      if (t === undefined) t = shards[s] = new Table(6, epoch);
      if (t.oM !== null) {
        t.credit += K;
        if (++t.pending >= t.batchN) {
          t.pending = 0;
          const n = t.credit | 0;
          if (n > 0) {
            t.credit -= n;
            migrate(t, n, 64 * n);
          }
        }
        if (t.oM !== null && t.used >= t.cap * 0.75) {
          st.forced++;
          forceFinish(t);
        }
      }
      if (t.oM === null) {
        const grow = t.used >= t.cap >> 1;
        if (grow || (t.cleanedEpoch !== epoch && t.used > 32)) {
          if (theta === 0) start(t, t.cleanedEpoch !== epoch ? sample(t) : 1, true);
          else {
            const f = sample(t);
            if (1 - f >= theta) start(t, f, true);
            else if (grow) start(t, 1, false);
            t.cleanedEpoch = epoch;
          }
        }
      }
      place(t, ((m << 6) & ~0xff) | ep8, new WeakRef(value));
      return value;
    },
    stats() {
      let stored = 0;
      let slots = 0;
      for (const t of shards) {
        if (t === undefined) continue;
        stored += t.used;
        slots += t.cap + (t.oM !== null ? t.oCap : 0);
      }
      return { stored, slots, epochs: epoch - 1, ...st };
    },
  };
}

// --- child: one pool, one scenario --------------------------------------------

function fmix(k) {
  k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
  k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
  return (k ^ (k >>> 16)) | 0;
}

async function child(poolName, scenarioName) {
  globalThis.gc ??= () => globalThis.Bun.gc(true); // JavaScriptCore, under Bun: a synchronous full collection
  const sc = SCENARIOS[scenarioName];
  const yieldTask = () => new Promise((r) => setImmediate(r));
  let pool;
  let shippedStats = null;
  if (poolName === 'shipped' || poolName === 'fr') {
    const mod = await import(poolName === 'fr' ? './fr-pool.mjs' : '../../dist/intern-pool.js');
    pool = mod.createInternPool();
    shippedStats = () => mod._poolStats(pool);
  } else if (poolName === 'null') {
    // harness only: key, hash, the {k} object, the live-array store, the hit's random read
    pool = { lookup: () => undefined, register: (v) => v };
  } else if (poolName === 'wr') {
    // harness + one WeakRef per insert, retained in a ring the size of a typical index
    const ring = new Array(1 << 20).fill(undefined);
    let at = 0;
    pool = { lookup: () => undefined, register(v) { ring[at] = new WeakRef(v); at = (at + 1) & (ring.length - 1); return v; } };
  } else {
    const [, k, ...opts] = poolName.split(' ');
    const gate = opts.find((o) => o.startsWith('gate'));
    const b = opts.find((o) => /^b\d+$/.test(o));
    pool = makeSemiPool(Number(k), opts.includes('+hits'), gate ? Number(gate.slice(4)) : 0, b ? Number(b.slice(1)) : 1);
  }

  const ablation = poolName === 'null' || poolName === 'wr';
  let prof = null;
  if (process.env.PROF) {
    const { Session } = await import('node:inspector/promises');
    prof = new Session();
    prof.connect();
    await prof.post('Profiler.enable');
    await prof.post('Profiler.setSamplingInterval', { interval: 200 });
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
    else live[rand() % live.length] = v; // the evicted member is the death
  }
  function hit() {
    const m = live[rand() % (HOT > 0 && HOT < live.length ? HOT : live.length)]; // HOT: hits go to the first HOT live slots
    wanted = m.k;
    const got = pool.lookup(fmix(m.k), pred);
    if (got !== m && !ablation) throw new Error('lost a live member');
  }

  // Prefill, untimed.
  for (let i = 0; i < sc.prefill; i++) {
    insert(sc.prefill);
    if (i % BATCH === BATCH - 1) await yieldTask();
  }
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await yieldTask();
    await yieldTask();
  }

  if (prof) await prof.post('Profiler.start');
  let opsMs = 0;
  let gcMs = 0;
  let turnMs = 0;
  let maxBatch = 0;
  let ops = 0;
  let sinceGc = 0;
  for (const ph of sc.phases) {
    if (live.length > ph.w) live.length = ph.w; // mass death
    for (let done = 0; done < ph.inserts; done += BATCH) {
      const t0 = performance.now();
      for (let i = 0; i < BATCH; i++) {
        insert(ph.w);
        for (let q = 0; q < ph.hits; q++) hit();
      }
      const t1 = performance.now();
      opsMs += t1 - t0;
      if (t1 - t0 > maxBatch) maxBatch = t1 - t0;
      ops += BATCH * (1 + ph.hits);
      sinceGc += BATCH;
      await yieldTask();
      const t2 = performance.now();
      turnMs += t2 - t1;
      if (sinceGc >= sc.gcEvery) {
        sinceGc = 0;
        globalThis.gc();
        gcMs += performance.now() - t2;
      }
    }
  }
  if (prof) {
    const { profile } = await prof.post('Profiler.stop');
    const fsm = await import('node:fs');
    fsm.writeFileSync(process.env.PROF, JSON.stringify(profile));
  }
  const before = pool.stats ? pool.stats() : ablation ? { stored: 0 } : shippedStats();
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await yieldTask();
    await yieldTask();
  }
  const mu = process.memoryUsage();
  const out = {
    nsPerOp: (opsMs * 1e6) / ops,
    gcMs,
    turnMs,
    maxBatch,
    stored: before.stored ?? before.slots,
    memMB: (mu.heapUsed + mu.arrayBuffers) / 2 ** 20,
    live: live.length,
    extra: pool.stats ? before : null,
  };
  console.log(JSON.stringify(out));
}

// --- parent --------------------------------------------------------------------

const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

if (process.argv[2] === 'child') {
  await child(process.argv[3], process.argv[4]);
} else {
  const rounds = Number(process.argv[2] ?? 3);
  const self = fileURLToPath(import.meta.url);
  console.log(`${process.env.RUNTIME ?? `node ${process.version}`}, ${rounds} rounds, median (min–max for ns/op)\n`);
  for (const scenario of Object.keys(SCENARIOS)) {
    console.log(`## ${scenario}`);
    console.log('pool            ns/op (min–max)      gc ms   turns ms   max batch   stored    mem MB   | migrated: by hit / no deref / →dead / →live');
    for (const pool of POOLS) {
      const rs = [];
      for (let r = 0; r < rounds; r++) {
        const runtime = process.env.RUNTIME;
        const p = spawnSync(runtime ?? process.execPath, [...(runtime ? [] : ['--expose-gc', '--max-old-space-size=8192']), self, 'child', pool, scenario], { encoding: 'utf8', timeout: 240_000 });
        if (p.status !== 0) {
          console.log(`${pool}: FAILED ${p.stderr.split('\n')[0]}`);
          continue;
        }
        rs.push(JSON.parse(p.stdout.trim().split('\n').pop()));
      }
      if (rs.length === 0) continue;
      const ns = rs.map((r) => r.nsPerOp);
      let extra = '';
      const e = rs[0].extra;
      if (e) {
        const t = e.byHit + e.skipped + e.derefDead + e.derefLive || 1;
        const pc = (x) => `${Math.round((100 * x) / t)}%`;
        extra = `| ${pc(e.byHit)} / ${pc(e.skipped)} / ${pc(e.derefDead)} / ${pc(e.derefLive)}   cycles ${e.cycles}, forced ${e.forced}, epochs ${e.epochs}`;
      }
      console.log(
        `${pool.padEnd(19)} ${med(ns).toFixed(0).padStart(5)} (${Math.min(...ns).toFixed(0)}–${Math.max(...ns).toFixed(0)})`.padEnd(36) +
          `${med(rs.map((r) => r.gcMs)).toFixed(0).padStart(6)} ${med(rs.map((r) => r.turnMs)).toFixed(0).padStart(9)} ${med(rs.map((r) => r.maxBatch)).toFixed(1).padStart(10)} ${String(med(rs.map((r) => r.stored))).padStart(9)} ${med(rs.map((r) => r.memMB)).toFixed(0).padStart(8)}   ${extra}`,
      );
    }
    console.log('');
  }
}
