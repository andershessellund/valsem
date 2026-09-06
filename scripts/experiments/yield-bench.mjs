// Task-per-produce benchmark: real apps produce once per event turn, so the
// WeakRef keptObjects list ([[KeptAlive]]) clears between produces. A
// synchronous loop retains EVERY WeakRef'd result until the job ends.
import { produce as vProduce } from '../../dist/produce.js';
import { intern } from '../../dist/intern.js';
import { produce as iProduce, setAutoFreeze } from 'immer';
import { create as mCreate } from 'mutative';
setAutoFreeze(false);

const N = 10000, ITER = 2000, mid = N >> 1;
const which = process.argv[2];
const items = new Array(N);
for (let i = 0; i < N; i++) items[i] = { id: i, label: `item-${i}`, value: 0 };
const yieldTask = () => new Promise((r) => setImmediate(r));

async function t(name, fn) {
  for (let i = 0; i < 200; i++) { fn(i); }
  await yieldTask();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) {
    fn(i);
    await yieldTask(); // one produce per task, like an event-driven app
  }
  const total = Number(process.hrtime.bigint() - t0) / ITER / 1000;
  // measure empty-yield overhead to subtract
  const y0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) await yieldTask();
  const yieldCost = Number(process.hrtime.bigint() - y0) / ITER / 1000;
  console.log(`  ${name.padEnd(22)} ${(total - yieldCost).toFixed(1).padStart(7)} µs/op (yield ${yieldCost.toFixed(1)} µs subtracted)`);
}

if (which === 'valsem') {
  const base = intern({ arr: items });
  await t('valsem', (i) => vProduce(base, (d) => { d.arr[mid].value = i; }));
} else if (which === 'immer') {
  const base = { arr: items.map((x) => ({ ...x })) };
  await t('immer (no freeze)', (i) => iProduce(base, (d) => { d.arr[mid].value = i; }));
} else {
  const base = { arr: items.map((x) => ({ ...x })) };
  await t('mutative', (i) => mCreate(base, (d) => { d.arr[mid].value = i; }));
}
