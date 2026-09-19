// ---------------------------------------------------------------------------
// soak.worker — one soak run, in a process of its own. Started by soak.mjs
// with a JSON config as its only argument; prints one JSON result line.
//
// A run is one server's life: build a live state of N entities, find what
// the process can serve flat out (a short saturated burst), then serve at
// fractions of that on an open-loop schedule — requests ARRIVE when the
// schedule says, whether or not the previous one is done, and latency runs
// from the arrival. See soak.mjs for the workloads and the columns.
// ---------------------------------------------------------------------------

import { PerformanceObserver, constants, performance } from 'node:perf_hooks';
import { ValueMap, produce, intern } from '../../dist/index.js';
import { _internPoolSize, _internPoolStats } from '../../dist/intern.js';
import { _pendingCount } from '../../dist/intern-pool.js';
import { Map as IMap } from 'immutable';
import { freeze as immerFreeze } from 'immer';

const config = JSON.parse(process.argv[2]);
const { workload, contender, live, seconds, burstSeconds, loads, referenceCapacity, ring: RING, rows: ROWS } = config;

if (typeof globalThis.gc !== 'function') throw new Error('soak.worker needs --expose-gc');

// --- the data --------------------------------------------------------------

const PLANS = ['free', 'team', 'business', 'enterprise'];
const CITIES = Array.from({ length: 64 }, (_, i) => `City ${i}`);
const TAGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** What JSON.parse or a database driver would hand a server: a fresh raw object graph. */
function entity(i, visits) {
  return {
    id: 'u' + i,
    email: `user${i}@example.com`,
    name: `User ${i}`,
    plan: PLANS[i & 3],
    visits,
    balance: i * 1.5,
    active: (i & 1) === 0,
    createdAt: 1_700_000_000_000 + i * 1000,
    address: { street: `${i} Main St`, city: CITIES[i & 63], zip: String(10_000 + (i % 90_000)) },
    tags: [TAGS[i & 7], TAGS[(i >> 3) & 7]],
  };
}

/** xorshift32, seeded: every contender sees the same requests and the same arrivals. */
function generator(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
}
const pick = generator(0x9e3779b9);
const arrival = generator(0x85ebca6b);
const rand = (n) => Math.floor(pick() * n);

// --- the contenders --------------------------------------------------------
//
// admit(raw)        the boundary step this contender's users run on new data
// build(N)          the live state: id → entity, in the contender's map
// edit(state, id)   one field of one entity, returning the next state

const CONTENDERS = {
  valsem: {
    admit: intern,
    build(n) {
      function* entries() {
        for (let i = 0; i < n; i++) yield ['u' + i, intern(entity(i, 0))];
      }
      return ValueMap.from(entries());
    },
    edit: (state, id) => produce(state, (d) => { d.get(id).visits++; }),
  },
  // The server with no library: a native Map, entities replaced, nothing frozen.
  plain: {
    admit: (raw) => raw,
    build(n) {
      const m = new Map();
      for (let i = 0; i < n; i++) m.set('u' + i, entity(i, 0));
      return m;
    },
    edit(state, id) {
      const e = state.get(id);
      state.set(id, { ...e, visits: e.visits + 1 });
      return state;
    },
  },
  // Deep-frozen on the way in, which is what immer's auto-freeze does to new data.
  frozen: {
    admit: (raw) => immerFreeze(raw, true),
    build(n) {
      const m = new Map();
      for (let i = 0; i < n; i++) m.set('u' + i, immerFreeze(entity(i, 0), true));
      return m;
    },
    edit(state, id) {
      const e = state.get(id);
      state.set(id, Object.freeze({ ...e, visits: e.visits + 1 }));
      return state;
    },
  },
  // A persistent map without interning or weak references: the structure, not the pool.
  immutable: {
    admit: (raw) => raw,
    build(n) {
      return IMap().withMutations((m) => {
        for (let i = 0; i < n; i++) m.set('u' + i, entity(i, 0));
      });
    },
    edit: (state, id) => state.update(id, (e) => ({ ...e, visits: e.visits + 1 })),
  },
};

// --- the workloads ---------------------------------------------------------

const held = new Array(RING).fill(null); // what a server keeps for a moment: recent responses, a cache
let novel = live; // ids past the live range: content nobody has seen

const WORKLOADS = {
  // One field of one entity. Little garbage: what collections cost over this much weak state.
  edit(c, state) {
    return c.edit(state, 'u' + rand(live));
  },
  // ROWS novel records admitted at the boundary, read, kept for RING requests, dropped.
  churn(c, state, seq) {
    const raw = new Array(ROWS);
    for (let j = 0; j < ROWS; j++) raw[j] = entity(novel++, seq);
    const rowsIn = c.admit(raw);
    let sum = 0;
    for (let j = 0; j < ROWS; j++) sum += rowsIn[j].visits;
    if (sum !== seq * ROWS) throw new Error('churn: wrong sum');
    held[seq % RING] = rowsIn;
    return state;
  },
  // The same, but the rows are what the state holds right now, arriving raw
  // again (a refetch, a cache fill): pool hits for valsem, copies for the rest.
  recur(c, state, seq) {
    const raw = new Array(ROWS);
    for (let j = 0; j < ROWS; j++) {
      const i = rand(live);
      raw[j] = entity(i, state.get('u' + i).visits);
    }
    held[seq % RING] = c.admit(raw);
    return state;
  },
  // What a stateful server mostly does: serve what it has, take in some new, change a little.
  mixed(c, state, seq) {
    const r = pick();
    return r < 0.8 ? WORKLOADS.recur(c, state, seq) : r < 0.95 ? WORKLOADS.churn(c, state, seq) : WORKLOADS.edit(c, state);
  },
};

// --- measuring -------------------------------------------------------------

/** Log-scale histogram of nanoseconds: 8 buckets per octave, ~9% resolution, no allocation per sample. */
class Histogram {
  counts = new Float64Array(8 * 48);
  n = 0;
  max = 0;
  sum = 0;
  record(ms) {
    const ns = ms * 1e6;
    const b = ns < 1 ? 0 : Math.min(this.counts.length - 1, Math.floor(Math.log2(ns) * 8));
    this.counts[b]++;
    this.n++;
    this.sum += ns;
    if (ns > this.max) this.max = ns;
  }
  quantile(q) {
    let seen = 0;
    const target = q * this.n;
    for (let b = 0; b < this.counts.length; b++) {
      seen += this.counts[b];
      if (seen >= target) return Math.min(this.max, 2 ** ((b + 1) / 8));
    }
    return this.max;
  }
  summary() {
    const us = (ns) => Math.round(ns / 10) / 100;
    return { mean: us(this.sum / Math.max(1, this.n)), p50: us(this.quantile(0.5)), p99: us(this.quantile(0.99)), p999: us(this.quantile(0.999)), max: us(this.max) };
  }
}

const GC_KINDS = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};
const SLOW_MS = 50; // pauses that get a line of their own, so a slow request can be laid beside a collection, or not

// Only collections V8 chose count. settle() forces its own, synchronous and
// without the concurrent marker: those are this harness's, not a server's.
let phase = null;
function countGc(entries) {
  if (phase === null) return;
  for (const e of entries) {
    if (e.startTime < phase.start) continue; // a forced collection of settle(), delivered late
    const kind = GC_KINDS[e.detail?.kind] ?? `kind ${e.detail?.kind}`;
    const s = (phase.gc[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    s.count++;
    s.totalMs += e.duration;
    if (e.duration > s.maxMs) s.maxMs = e.duration;
    const atMs = Math.round(e.startTime - phase.start);
    if (e.duration >= SLOW_MS) phase.slowCollections.push({ kind, atMs, ms: Math.round(e.duration) });
    // The heap right after a major collection is the floor of that cycle:
    // a leak is a floor that climbs, whatever the peaks do.
    if (kind === 'major') phase.floors.push({ atMs, heapMB: MB(process.memoryUsage().heapUsed) });
  }
}
const observer = new PerformanceObserver((list) => countGc(list.getEntries()));
observer.observe({ entryTypes: ['gc'] });

const task = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = (bytes) => Math.round(bytes / 2 ** 20);

/** Forced collections, then the idle time valsem's pool cleanup needs, so that what is measured next is what stays. */
async function settle() {
  for (let i = 0; i < 2; i++) {
    globalThis.gc();
    for (let k = 0; k < 4; k++) await task();
  }
  const patience = performance.now() + 5000;
  while (contender === 'valsem' && _pendingCount() > 0 && performance.now() < patience) await task();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

const pool = () => (contender === 'valsem' ? { live: _internPoolSize(), ..._internPoolStats(), pending: _pendingCount() } : null);

const c = CONTENDERS[contender];
const serve = WORKLOADS[workload];
let state = null;
let seq = 0;

/**
 * Serve for `durationMs`. With a rate, arrivals are a Poisson process at that
 * rate and latency runs from each arrival: a pause delays everything queued
 * behind it, and all of it counts. Without one, the next request starts when
 * the last one ends: that is capacity, and its latencies mean nothing.
 * One request per macrotask either way, so finalizers and the pool's cleanup
 * get the turns a server's event loop would give them.
 */
async function run(durationMs, rate) {
  phase = { start: performance.now(), gc: {}, slowCollections: [], floors: [] };
  const service = new Histogram();
  const latency = new Histogram();
  const slowRequests = [];
  const stalls = []; // the loop handed control away and got it back late: something else held the thread
  const yielded = async (wait, intendedMs) => {
    const t = performance.now();
    await wait;
    const late = performance.now() - t - intendedMs;
    if (late >= SLOW_MS && stalls.length < 20) stalls.push({ atMs: Math.round(t - start), ms: Math.round(late) });
  };
  let peakHeap = 0;
  let peakRss = 0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    if (m.rss > peakRss) peakRss = m.rss;
  }, 250);

  const start = phase.start;
  const deadline = start + durationMs;
  let requests = 0;
  let next = start;
  for (;;) {
    let now = performance.now();
    if (now >= deadline) break;
    if (rate !== null && now < next) {
      // Timers are good to a millisecond; the last stretch is spent turning the loop.
      if (next - now > 3) await yielded(sleep(next - now - 2), next - now - 2);
      else await yielded(task(), 0);
      continue;
    }
    const arrived = rate === null ? now : next;
    state = serve(c, state, seq++);
    const done = performance.now();
    service.record(done - now);
    latency.record(done - arrived);
    if (done - now >= SLOW_MS && slowRequests.length < 20) slowRequests.push({ atMs: Math.round(now - start), ms: Math.round(done - now) });
    requests++;
    if (rate !== null) next += (-Math.log(1 - arrival()) / rate) * 1000;
    await yielded(task(), 0);
  }
  const wallMs = performance.now() - start;
  clearInterval(sampler);
  await task();
  countGc(observer.takeRecords());
  const measured = phase;
  phase = null;

  const gcMs = Object.values(measured.gc).reduce((a, s) => a + s.totalMs, 0);
  const kind = (k) => {
    const s = measured.gc[k] ?? { count: 0, totalMs: 0, maxMs: 0 };
    return { count: s.count, totalMs: Math.round(s.totalMs), maxMs: Math.round(s.maxMs * 10) / 10 };
  };
  return {
    offeredPerSecond: rate === null ? null : Math.round(rate),
    requests,
    servedPerSecond: Math.round(requests / (wallMs / 1000)),
    latencyUs: latency.summary(),
    serviceUs: service.summary(),
    gc: { shareOfWall: Math.round((gcMs / wallMs) * 1000) / 10, minor: kind('minor'), major: kind('major'), incremental: kind('incremental'), weakcb: kind('weakcb') },
    heapFloorsMB: measured.floors,
    peakHeapMB: MB(peakHeap),
    peakRssMB: MB(peakRss),
    slow: { requests: slowRequests, stalls, collections: measured.slowCollections },
  };
}

// --- the run ---------------------------------------------------------------

const emptyHeap = await settle();
const t0 = performance.now();
state = c.build(live);
const buildMs = performance.now() - t0;
const builtHeap = await settle();
const builtPool = pool();

for (let i = 0; i < 2000; i++) state = serve(c, state, seq++); // warm-up, unmeasured
await task();

const burst = await run(burstSeconds * 1000, null);
const capacity = burst.servedPerSecond;
const phases = [];
// The offered load is the same for every contender: a server's traffic does not depend on its libraries.
const reference = referenceCapacity ?? capacity;
for (const load of loads) phases.push({ load, ...(await run(seconds * 1000, reference * load)) });
const busyPool = pool();

// What is left when the traffic stops: the state, and nothing of the churn.
held.fill(null);
const settledHeap = await settle();
const settledPool = pool();
if (state.size !== live) throw new Error(`state has ${state.size} entities, expected ${live}`);

console.log(
  JSON.stringify({
    workload,
    contender,
    live,
    buildSeconds: Math.round(buildMs / 100) / 10,
    bytesPerEntity: Math.round((builtHeap - emptyHeap) / live),
    builtHeapMB: MB(builtHeap),
    capacityPerSecond: capacity,
    burst,
    phases,
    settledHeapMB: MB(settledHeap),
    heapGrowthMB: MB(settledHeap - builtHeap),
    pool: builtPool === null ? null : { built: builtPool, busy: busyPool, settled: settledPool },
  }),
);
process.exit(0);
