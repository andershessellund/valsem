// ---------------------------------------------------------------------------
// pool-gc-bench — sweep-based InternPool vs FinalizationRegistry-based pool.
//
// Compares three cleanup strategies over identical Map<hash, Set<WeakRef>>
// bucket structures:
//
//   sweep    — the shipped InternPool (threshold sweep inside register)
//   fr       — FinalizationRegistry per entry (the global pool's mechanism)
//   none     — no cleanup at all (baseline; isolates each strategy's tax)
//
// Methodology notes:
// - Batches yield to the event loop (setImmediate) so FinalizationRegistry
//   callbacks — which run as post-GC tasks — actually execute inside the
//   measured window. A fully synchronous loop would defer their entire cost
//   past the finish line.
// - "max batch" is the slowest single batch — a proxy for pause spikes
//   (monolithic sweeps on the sweep pool; GC + finalization storms on fr).
// - The dormancy phase measures retained heap after all values die and
//   activity stops: run with --expose-gc for meaningful numbers.
// - Phases share a process; drain() (gc + yields) runs between phases to
//   limit contamination. Residual cross-talk is a known caveat.
//
// Run: pnpm build && node --expose-gc scripts/pool-gc-bench.mjs [N]
// ---------------------------------------------------------------------------

import { createInternPool } from '../dist/intern-pool.js';
import { createSweeper, createCirclePool } from './circle-pool.mjs';

const N = Number(process.argv[2] ?? 500_000);
const BATCH = 5_000;
const WINDOW = 100_000; // bucket-reuse window for the reuse phase
const WORKING_SET = 50_000;

const gc = globalThis.gc ?? (() => {});
if (typeof globalThis.gc !== 'function') {
  console.warn('WARNING: run with --expose-gc; dormancy numbers are meaningless without it.\n');
}

const yieldTask = () => new Promise((resolve) => setImmediate(resolve));

async function drain() {
  for (let i = 0; i < 5; i++) {
    gc();
    // Two turns: FinalizationRegistry callbacks are queued as their own task
    // after GC and may land behind the first setImmediate.
    await yieldTask();
    await yieldTask();
  }
}

// --- contenders ------------------------------------------------------------

function makeSweepPool() {
  const pool = createInternPool();
  return {
    name: 'sweep',
    lookup: (hash, predicate) => pool.lookup(hash, predicate),
    register: (value, hash) => pool.register(value, hash),
    live: () => pool.size(),
    metaSlots: () => NaN, // not observable from outside
  };
}

// Mirrors the global pool in src/intern.ts: one FinalizationRegistry entry per
// pooled value; the callback removes the dead ref from its bucket.
function makeFRPool() {
  const buckets = new Map();
  const registry = new FinalizationRegistry(({ hash, ref }) => {
    const bucket = buckets.get(hash);
    if (!bucket) return;
    bucket.delete(ref);
    if (bucket.size === 0) buckets.delete(hash);
  });
  return {
    name: 'fr',
    lookup(hash, predicate) {
      const bucket = buckets.get(hash);
      if (bucket === undefined) return undefined;
      for (const ref of bucket) {
        const candidate = ref.deref();
        if (candidate !== undefined && predicate(candidate)) return candidate;
      }
      return undefined;
    },
    register(value, hash) {
      let bucket = buckets.get(hash);
      if (bucket === undefined) {
        bucket = new Set();
        buckets.set(hash, bucket);
      }
      const ref = new WeakRef(value);
      bucket.add(ref);
      registry.register(value, { hash, ref });
      return value;
    },
    live() {
      let n = 0;
      for (const bucket of buckets.values()) {
        for (const ref of bucket) if (ref.deref() !== undefined) n++;
      }
      return n;
    },
    metaSlots() {
      let n = 0;
      for (const bucket of buckets.values()) n += bucket.size;
      return n;
    },
  };
}

function makeCircle(name, opts) {
  const pool = createCirclePool(createSweeper(opts));
  return {
    name,
    lookup: pool.lookup,
    register: pool.register,
    live: pool.live,
    metaSlots: pool.metaSlots,
  };
}
const makeCirclePoolContender = () => makeCircle('circle', {});
// With the backstop, GC epochs pay the death tax — lookups pay nothing.
const makeCircleGcContender = () =>
  makeCircle('circ+gc', { gcBackstop: true, lookupBudget: 0 });

function makeNoCleanupPool() {
  const buckets = new Map();
  return {
    name: 'none',
    lookup(hash, predicate) {
      const bucket = buckets.get(hash);
      if (bucket === undefined) return undefined;
      for (const ref of bucket) {
        const candidate = ref.deref();
        if (candidate !== undefined && predicate(candidate)) return candidate;
      }
      return undefined;
    },
    register(value, hash) {
      let bucket = buckets.get(hash);
      if (bucket === undefined) {
        bucket = new Set();
        buckets.set(hash, bucket);
      }
      bucket.add(new WeakRef(value));
      return value;
    },
    live() {
      let n = 0;
      for (const bucket of buckets.values()) {
        for (const ref of bucket) if (ref.deref() !== undefined) n++;
      }
      return n;
    },
    metaSlots() {
      let n = 0;
      for (const bucket of buckets.values()) n += bucket.size;
      return n;
    },
  };
}

// --- phases ----------------------------------------------------------------

// Register N unique values, dropping each immediately. `window` folds hashes
// so buckets are reused and lookups wade through whatever dead refs the
// strategy has not yet cleaned (stress magnifier: real 32-bit hashes would
// essentially never reuse buckets at this N).
async function churnPhase(pool, { window } = {}) {
  const t0 = process.hrtime.bigint();
  let maxBatch = 0n;
  let maxGap = 0n; // slowest yield turn — FR callbacks and GC land here
  for (let done = 0; done < N; ) {
    const b0 = process.hrtime.bigint();
    const end = Math.min(done + BATCH, N);
    for (; done < end; done++) {
      const hash = window ? done % window : done;
      const value = { v: done };
      if (pool.lookup(hash, (c) => c.v === done) === undefined) {
        pool.register(value, hash);
      }
    }
    const g0 = process.hrtime.bigint();
    const dt = g0 - b0;
    if (dt > maxBatch) maxBatch = dt;
    await yieldTask();
    const gap = process.hrtime.bigint() - g0;
    if (gap > maxGap) maxGap = gap;
  }
  return { wall: process.hrtime.bigint() - t0, maxBatch, maxGap };
}

// Register N unique values while keeping the most recent WORKING_SET alive.
async function workingSetPhase(pool) {
  const live = new Array(WORKING_SET);
  const t0 = process.hrtime.bigint();
  let maxBatch = 0n;
  let maxGap = 0n;
  for (let done = 0; done < N; ) {
    const b0 = process.hrtime.bigint();
    const end = Math.min(done + BATCH, N);
    for (; done < end; done++) {
      const value = { v: done };
      if (pool.lookup(done, (c) => c.v === done) === undefined) {
        pool.register(value, done);
      }
      live[done % WORKING_SET] = value;
    }
    const g0 = process.hrtime.bigint();
    const dt = g0 - b0;
    if (dt > maxBatch) maxBatch = dt;
    await yieldTask();
    const gap = process.hrtime.bigint() - g0;
    if (gap > maxGap) maxGap = gap;
  }
  const wall = process.hrtime.bigint() - t0;
  live.length = 0;
  return { wall, maxBatch, maxGap };
}

// Pure hit traffic against a small live population — read-path parity check.
async function hitPhase(pool) {
  const K = 10_000;
  const held = [];
  for (let i = 0; i < K; i++) {
    const value = { v: i };
    held.push(value);
    pool.register(value, i);
  }
  const t0 = process.hrtime.bigint();
  let maxBatch = 0n;
  let maxGap = 0n;
  let misses = 0;
  for (let done = 0; done < N; ) {
    const b0 = process.hrtime.bigint();
    const end = Math.min(done + BATCH, N);
    for (; done < end; done++) {
      const want = done % K;
      if (pool.lookup(want, (c) => c.v === want) === undefined) misses++;
    }
    const g0 = process.hrtime.bigint();
    const dt = g0 - b0;
    if (dt > maxBatch) maxBatch = dt;
    await yieldTask();
    const gap = process.hrtime.bigint() - g0;
    if (gap > maxGap) maxGap = gap;
  }
  const wall = process.hrtime.bigint() - t0;
  if (misses > 0) console.warn(`  (!) hit phase had ${misses} unexpected misses`);
  held.length = 0;
  return { wall, maxBatch, maxGap };
}

// Grow, drop everything, stop all activity: what stays behind?
async function dormancyPhase(pool) {
  await drain();
  const before = process.memoryUsage().heapUsed;
  const M = Math.min(N, 200_000);
  for (let i = 0; i < M; ) {
    const end = Math.min(i + BATCH, M);
    for (; i < end; i++) pool.register({ v: i }, i);
    await yieldTask();
  }
  await drain(); // values are dead; FR callbacks get every chance to run
  const after = process.memoryUsage().heapUsed;
  return {
    retainedKB: Math.max(0, Math.round((after - before) / 1024)),
    live: pool.live(),
    metaSlots: pool.metaSlots(),
    entries: M,
  };
}

// --- driver ----------------------------------------------------------------

const ms = (ns) => Number(ns / 1000n) / 1000;
const mops = (ns) => (N / (Number(ns) / 1e9) / 1e6).toFixed(2);

async function runContender(makePool) {
  const results = {};
  let pool = makePool();
  results.name = pool.name;

  await drain();
  // Warmup (JIT) on a throwaway portion.
  for (let i = 0; i < 50_000; i++) {
    const value = { v: i };
    if (pool.lookup(i, (c) => c.v === i) === undefined) pool.register(value, i);
  }
  await drain();

  pool = makePool();
  results.churn = await churnPhase(pool);
  await drain();

  pool = makePool();
  results.reuse = await churnPhase(pool, { window: WINDOW });
  await drain();

  pool = makePool();
  results.workingSet = await workingSetPhase(pool);
  await drain();

  pool = makePool();
  results.hits = await hitPhase(pool);
  await drain();

  pool = makePool();
  results.dormancy = await dormancyPhase(pool);
  await drain();

  return results;
}

console.log(`pool-gc-bench: N=${N} ops/phase, batch=${BATCH}, node ${process.version}\n`);

const all = [];
for (const make of [
  makeSweepPool,
  makeFRPool,
  makeCirclePoolContender,
  makeCircleGcContender,
  makeNoCleanupPool,
]) {
  const r = await runContender(make);
  all.push(r);
  console.log(`— ${r.name} done`);
}

console.log('\nphase          | pool    |    wall ms |  Mops/s | max batch ms | max gap ms');
console.log('---------------|---------|-----------:|--------:|-------------:|----------:');
for (const phase of ['churn', 'reuse', 'workingSet', 'hits']) {
  for (const r of all) {
    const p = r[phase];
    console.log(
      `${phase.padEnd(14)} | ${r.name.padEnd(7)} | ${ms(p.wall).toFixed(1).padStart(10)} | ${mops(p.wall).padStart(7)} | ${ms(p.maxBatch).toFixed(2).padStart(12)} | ${ms(p.maxGap).toFixed(2).padStart(10)}`,
    );
  }
}

console.log('\ndormancy (grow → drop all → stop; what stays behind)');
console.log('pool    | entries | live | meta slots | retained KB');
console.log('--------|--------:|-----:|-----------:|-----------:');
for (const r of all) {
  const d = r.dormancy;
  const meta = Number.isNaN(d.metaSlots) ? 'n/a' : String(d.metaSlots);
  console.log(
    `${r.name.padEnd(7)} | ${String(d.entries).padStart(7)} | ${String(d.live).padStart(4)} | ${meta.padStart(10)} | ${String(d.retainedKB).padStart(11)}`,
  );
}
