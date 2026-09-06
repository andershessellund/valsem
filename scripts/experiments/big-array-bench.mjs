// ---------------------------------------------------------------------------
// big-array-bench — the definitive plain-array arena.
//
// Corrects the two artifacts found in earlier rounds:
//   a) results are HELD (ring of 50) — real applications hold what they
//      produce; discarded results die in the scavenger nursery and flatter
//      unfrozen libraries;
//   b) one op per scheduling unit — a synchronous loop force-retains every
//      WeakRef'd result until the job ends (AddToKeptObjects), which is a
//      batch-loop artifact, not the event-driven regime.
//
// Modes: sync | micro (await Promise.resolve() — one promise job per op) |
// macro (await setImmediate — one task per op). The micro/macro split also
// measures WHERE the engine clears the kept-objects list.
//
// One (contender, mode) pair per process — in-process scenario order
// corrupts numbers via heap cross-pollination:
//   for c in valsem immer mutative; do for m in sync micro macro; do
//     node scripts/big-array-bench.mjs $c $m; done; done
// ---------------------------------------------------------------------------
import { produce as vProduce } from '../../dist/produce.js';
import { intern } from '../../dist/intern.js';
import { produce as iProduce, setAutoFreeze } from 'immer';
import { create as mCreate } from 'mutative';
setAutoFreeze(false); // immer's best case

const [contender = 'valsem', mode = 'micro'] = process.argv.slice(2);
const N = 10000, ITER = 2000, mid = N >> 1;

function makeItems() {
  const a = new Array(N);
  for (let i = 0; i < N; i++) a[i] = { id: i, label: `item-${i}`, value: 0 };
  return a;
}

const yields = {
  sync: null,
  micro: () => Promise.resolve(),
  macro: () => new Promise((r) => setImmediate(r)),
};

let fn;
if (contender === 'valsem') {
  const base = intern({ arr: makeItems() });
  fn = (i) => vProduce(base, (d) => { d.arr[mid].value = i; });
} else if (contender === 'immer') {
  const base = { arr: makeItems() };
  fn = (i) => iProduce(base, (d) => { d.arr[mid].value = i; });
} else {
  const base = { arr: makeItems() };
  fn = (i) => mCreate(base, (d) => { d.arr[mid].value = i; });
}

const y = yields[mode];
const ring = new Array(50);
for (let i = 0; i < 200; i++) { ring[i % 50] = fn(i); if (y) await y(); }
const t0 = process.hrtime.bigint();
for (let i = 0; i < ITER; i++) { ring[i % 50] = fn(i); if (y) await y(); }
const total = Number(process.hrtime.bigint() - t0) / ITER / 1000;
let overhead = 0;
if (y) {
  const o0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) await y();
  overhead = Number(process.hrtime.bigint() - o0) / ITER / 1000;
}
console.log(
  `${contender.padEnd(9)} ${mode.padEnd(6)} ${(total - overhead).toFixed(1).padStart(7)} µs/op` +
    (y ? `  (yield ${overhead.toFixed(2)} µs subtracted)` : ''),
);
