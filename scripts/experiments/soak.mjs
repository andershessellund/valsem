// ---------------------------------------------------------------------------
// soak — what a stateful server would feel: a large live state indexed by
// the weak pool, and a steady stream of values admitted and dropped under it.
//
// The benchmarks in bench/ measure operations against a working set of tens
// of thousands of values. This asks the other question: with MILLIONS of
// canonical values alive, each behind a WeakRef, a pool slot and a WeakMap
// entry, what do tail latency, the garbage
// collector and the heap look like at the load a server actually runs at?
//
// Each run is one process (soak.worker.mjs) living one server's life:
//
//   1. build a live state of N entities (id → a 10-field record with a
//      nested record and an array), and settle;
//   2. a short SATURATED burst, the next request starting when the last one
//      ends: that is capacity, and the only thing the burst is good for;
//   3. OPEN-LOOP phases at fractions of the FIRST contender's capacity (the
//      same requests per second for everyone: a server's traffic does not
//      depend on its libraries, so list the slowest first). Requests arrive as a
//      Poisson process whether or not the process is ready, and latency runs
//      from the arrival, so a pause counts against everything queued behind
//      it. A server sits well below saturation, and V8's concurrent marker
//      is built around the slack: tails measured flat out are an overloaded
//      process's tails.
//
// One request per macrotask throughout, so finalizers and the pool's
// idle-time cleanup get the turns an event loop would give them.
//
// Workloads (--workloads):
//   mixed  80% recur, 15% churn, 5% edit: serve what you have, take in some
//          new, change a little. The default.
//   recur  100 rows the state already holds arrive raw again (a refetch):
//          pool hits for valsem, copies for everyone else
//   churn  100 NOVEL rows admitted, read, kept for 64 requests, dropped
//   edit   one field of one entity
//
// Contenders (--contenders), because a number without a baseline is V8's:
//   valsem     ValueMap + intern + produce
//   plain      a native Map of plain objects, entities replaced on edit
//   frozen     the same, deep-frozen on the way in (immer's auto-freeze walk)
//   immutable  Immutable.js Map of plain objects: persistent, no pool, no
//              weak references
// (immer's produce copies the whole native Map per edit, O(N): not this
// experiment.)
//
// Columns: capacity = req/s in the burst; load = the offered rate; latency
// from arrival (so it includes the queueing behind a pause, and behind the
// main thread's share of incremental marking, which V8 reports as many short
// steps and no pause at all); GC = share of wall time in collections V8 chose (the forced
// ones around the build are not counted), and major collections as count /
// longest pause; floor = heap right after the first and the last major
// collection of the phase, which is where a leak would show; bytes/entity =
// settled heap after the build ÷ N; backlog = pool slots stored − live
// members once traffic stopped and cleanup had its turns.
//
// Under each table, every request over 50 ms is laid beside the collections
// of that phase: a slow request with no collection next to it is not the
// collector's.
//
// Run:  pnpm build && node scripts/experiments/soak.mjs [options]
//   --live 1             live entities, in millions; a list runs each
//   --loads 0.25,0.5     fractions of the first contender's capacity
//   --seconds 40         per load phase        --burst 5   the saturated burst
//   --workloads mixed    --contenders valsem,plain
//   --heap <MB>          --max-old-space-size for the workers. Default: four
//                        times valsem's live heap for the size, as a container
//                        would be sized. A huge limit lets garbage pile up and
//                        makes collections rare and large.
//   --sweep              live 0.25,1,3 × every workload × every contender
//   --quick              live 0.05, short phases: a smoke test of the harness
//   --out file.json      also write every result as JSON
//
// The default is two processes and about four minutes. An entity here is two
// canonical records. What this harness found is in DECISIONS.md: D48 (the
// pool index, sharded since) and D49 (the meta WeakMap's rebuild pause).
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const quick = flag('quick');
const sweep = flag('sweep');
const ALL_WORKLOADS = ['mixed', 'recur', 'churn', 'edit'];
const ALL_CONTENDERS = ['valsem', 'plain', 'frozen', 'immutable'];

const lives = option('live', quick ? '0.05' : sweep ? '0.25,1,3' : '1').split(',').map((m) => Math.round(Number(m) * 1e6));
const loads = option('loads', '0.25,0.5').split(',').map(Number);
const seconds = Number(option('seconds', quick ? '3' : '40'));
const burstSeconds = Number(option('burst', quick ? '2' : '5'));
const workloads = option('workloads', sweep ? ALL_WORKLOADS.join(',') : 'mixed').split(',');
const contenders = option('contenders', sweep ? ALL_CONTENDERS.join(',') : 'valsem,plain').split(',');
const heapOption = option('heap', null);
const out = option('out', null);

for (const w of workloads) if (!ALL_WORKLOADS.includes(w)) throw new Error(`unknown workload ${w}`);
for (const c of contenders) if (!ALL_CONTENDERS.includes(c)) throw new Error(`unknown contender ${c}`);
if (lives.some((n) => !(n > 0))) throw new Error('--live takes millions of entities, e.g. 0.25,1,3');
if (loads.some((l) => !(l > 0))) throw new Error('--loads takes fractions of capacity, e.g. 0.25,0.5');

// ~1.1 KB of heap per live entity for valsem; every contender of a size gets the same limit.
const heapFor = (live) => (heapOption !== null ? Number(heapOption) : Math.max(1024, Math.ceil((live * 1100 * 4) / 2 ** 20 / 512) * 512));

const WORKER = fileURLToPath(new URL('./soak.worker.mjs', import.meta.url));

function run(config) {
  const r = spawnSync(process.execPath, ['--expose-gc', `--max-old-space-size=${heapFor(config.live)}`, WORKER, JSON.stringify(config)], {
    encoding: 'utf8',
    maxBuffer: 2 ** 26,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    const lines = (r.stderr || r.stdout || '').trim().split('\n');
    const why = lines.find((l) => /Error|FATAL|exceeded|out of memory/i.test(l)) ?? `exit ${r.status ?? r.signal}`;
    return { ...config, failed: why.trim() };
  }
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const us = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} s` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} ms` : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} µs`);
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2)}M` : `${Math.round(n / 1e3)}k`);
const num = (n) => n.toLocaleString('en');

const HEAD = ['live', 'contender', 'capacity', 'load', 'latency p50', 'p99', 'p99.9', 'max', 'service p50', 'GC', 'major n / longest', 'heap floor', 'peak heap', 'bytes/entity', 'backlog'];

function rows(r) {
  if (r.failed !== undefined) return [[count(r.live), r.contender, `FAILED: ${r.failed}`]];
  const p = r.pool?.settled;
  return r.phases.map((ph) => {
    const floors = ph.heapFloorsMB;
    return [
      count(r.live),
      r.contender,
      `${num(r.capacityPerSecond)}/s`,
      `${Math.round(ph.load * 100)}% = ${num(ph.offeredPerSecond)}/s`,
      us(ph.latencyUs.p50),
      us(ph.latencyUs.p99),
      us(ph.latencyUs.p999),
      us(ph.latencyUs.max),
      us(ph.serviceUs.p50),
      `${ph.gc.shareOfWall}%`,
      `${ph.gc.major.count} / ${ph.gc.major.maxMs} ms`,
      floors.length === 0 ? '—' : floors.length === 1 ? `${floors[0].heapMB} MB` : `${floors[0].heapMB} → ${floors.at(-1).heapMB} MB`,
      `${ph.peakHeapMB} MB`,
      `${r.bytesPerEntity}`,
      p ? num(p.slots - p.live) : '—',
    ];
  });
}

/** Every slow request of a phase, and whether a collection of that phase overlaps it. */
function slowLines(r) {
  const lines = [];
  for (const ph of [{ load: 'burst', ...r.burst }, ...r.phases]) {
    const label = `${count(r.live)} ${r.contender}, ${ph.load === 'burst' ? 'burst' : `${Math.round(ph.load * 100)}%`}`;
    for (const st of ph.slow.stalls) lines.push(`- ${label}: the event loop came back ${st.ms} ms late at ${(st.atMs / 1000).toFixed(1)} s`);
    for (const q of ph.slow.requests) {
      const gc = ph.slow.collections.find((g) => g.atMs < q.atMs + q.ms && q.atMs < g.atMs + g.ms);
      lines.push(`- ${label}: a request at ${(q.atMs / 1000).toFixed(1)} s took ${q.ms} ms — ${gc ? `a ${gc.kind} collection of ${gc.ms} ms overlaps it` : 'no collection overlaps it'}`);
    }
    const alone = ph.slow.collections.filter((g) => !ph.slow.requests.some((q) => g.atMs < q.atMs + q.ms && q.atMs < g.atMs + g.ms));
    for (const g of alone) lines.push(`- ${label}: a ${g.kind} collection at ${(g.atMs / 1000).toFixed(1)} s paused ${g.ms} ms, between requests`);
  }
  return lines;
}

console.log(`# soak — node ${process.versions.node} (V8 ${process.versions.v8}), ${cpus()[0].model}, ${Math.round(totalmem() / 2 ** 30)} GB`);
console.log(`burst ${burstSeconds} s, then ${seconds} s at each of ${loads.map((l) => `${Math.round(l * 100)}%`).join(', ')} of capacity; one request per macrotask\n`);

const results = [];
for (const workload of workloads) {
  console.log(`## ${workload}\n`);
  console.log(`| ${HEAD.join(' | ')} |`);
  console.log(`| ${HEAD.map(() => '---').join(' | ')} |`);
  const slow = [];
  for (const live of lives) {
    let referenceCapacity = null;
    for (const contender of contenders) {
      const r = run({ workload, contender, live, seconds, burstSeconds, loads, referenceCapacity, ring: 64, rows: 100 });
      referenceCapacity ??= r.capacityPerSecond ?? null;
      r.heapLimitMB = heapFor(live);
      results.push(r);
      for (const cells of rows(r)) console.log(`| ${cells.join(' | ')} |`);
      if (r.failed === undefined) slow.push(...slowLines(r));
    }
  }
  console.log(`\nRequests, event-loop stalls and collections over 50 ms:\n\n${slow.length ? slow.join('\n') : '- none'}\n`);
}

if (out !== null) {
  writeFileSync(out, JSON.stringify({ node: process.versions.node, v8: process.versions.v8, cpu: cpus()[0].model, seconds, burstSeconds, loads, results }, null, 2) + '\n');
  console.log(`wrote ${out}`);
}
