// One column of the skip-freezing suite, in a process of its own: skipFreezing()
// is a one-way switch per process. Prints { "row name": ns } as JSON.
//
//   node bench/suites/skip-freezing.worker.mjs on|off
import { time, timeHeld } from '../lib.mjs';
import { intern } from '../../dist/intern.js';
import { produce } from '../../dist/produce.js';
import { skipFreezing } from '../../dist/checks.js';
import { ValueList } from '../../dist/value-list.js';

if (process.argv[2] === 'off') skipFreezing();

const N = 10_000;
const records = () => Array.from({ length: N }, (_, i) => ({ id: i, v: i, tags: ['a', 'b'] }));
const out = {};
// Results are retained in a ring of 50, as state is. The large-array row also
// runs one call per macrotask (lib.mjs's honest regime for update libraries):
// in a tight synchronous loop a 10,000-element copy per call measures the
// garbage collector's mood more than the edit.
const ring = new Array(50);
let slot = 0;
const keep = (v) => (ring[slot++ % 50] = v);

// Each cell is the BEST of several repetitions. The two columns come from two
// processes, so they cannot be interleaved, and a single pass of a
// microsecond-scale row wanders by ±50% with GC timing: enough to invent a
// difference where the engine has none. The minimum is the run least disturbed.
const REPS = 5;
const best = async (measure) => {
  let min = Infinity;
  for (let r = 0; r < REPS; r++) min = Math.min(min, await measure());
  return min;
};

// --- valsem's own operations ------------------------------------------------
{
  const base = intern({ arr: records() });
  out['produce: one edit in a 10,000-record plain array'] = await best(() => timeHeld((i) => produce(base, (d) => { d.arr[N >> 1].v = -i; }), 1500));
}
{
  const base = intern({ list: ValueList.from(records()) });
  out['produce: the same edit, in a ValueList'] = await best(() => time((i) => keep(produce(base, (d) => { d.list.get(N >> 1).v = -i; })), 3000));
}
{
  const base = intern({ a: 1, b: 2, c: 3 });
  out['produce: one field of a 3-key record'] = await best(() => time((i) => keep(produce(base, (d) => { d.a = -i; })), 100_000));
}
{
  const inputs = Array.from({ length: 60 }, (_, k) => Array.from({ length: N }, (_, i) => i * 61 + k));
  let k = 0;
  out['intern: a new 10,000-number array'] = await best(() => time(() => keep(intern(inputs[k++ % 60].slice())), 60, 0));
}
{
  const make = (k) => Array.from({ length: 1000 }, (_, i) => ({ id: i, a: k, b: 'x', c: true, d: null, e: i * 2, f: 'y', g: k + i, h: 1, i: 2 }));
  let k = 0;
  out['intern: 1,000 new 10-field records'] = await best(() => time(() => keep(intern(make(k++))), 120, 5));
}

// --- your code, reading canonical state --------------------------------------
{
  const state = intern({ arr: records() });
  const arr = state.arr;
  let sum = 0;
  out['your code: indexed loop over a canonical 10,000-record array'] = await best(() => time(() => { for (let i = 0; i < arr.length; i++) sum += arr[i].v; }, 1500));
  out['your code: for…of'] = await best(() => time(() => { for (const r of arr) sum += r.v; }, 1500));
  out['your code: arr.filter(…)'] = await best(() => time(() => { sum += arr.filter((r) => r.v & 1).length; }, 800));
  out['your code: arr.map(…)'] = await best(() => time(() => { sum += arr.map((r) => r.v).length; }, 800));
  out['your code: JSON.stringify(state)'] = await best(() => time(() => { sum += JSON.stringify(state).length; }, 60));
  const list = ValueList.from(records());
  out['your code: for…of over a ValueList of the same records'] = await best(() => time(() => { for (const r of list) sum += r.v; }, 800));
  if (sum === 0) throw new Error('unreachable: keeps the loops observable');
}

console.log(JSON.stringify(out));
