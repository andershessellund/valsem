import { intern, _internPrehashed, _accOf } from '../dist/intern.js';
import { _arrayHashOf } from '../dist/deep-hash.js';
import { produce as vProduce } from '../dist/produce.js';
const N = 10000, ITER = 2000, mid = N >> 1;
const which = process.argv[2];
const items = new Array(N);
for (let i = 0; i < N; i++) items[i] = { id: i, label: `item-${i}`, value: 0 };
const base = intern({ arr: items });
const arr = base.arr;
const shadow = [...arr];
const accInfo = _accOf(arr);
const wm = new WeakMap();
const yieldTask = () => new Promise((r) => setImmediate(r));

const variants = {
  'slice': () => shadow.slice(),
  'slice+freeze': () => Object.freeze(shadow.slice()),
  'slice+freeze+2xWeakMap': (i) => { const c = Object.freeze(shadow.slice()); wm.set(c, i); wm.set(c, i + 1); return c; },
  'slice+freeze+WeakRef': () => { const c = Object.freeze(shadow.slice()); return new WeakRef(c); },
  'slice+prehashed': (i) => {
    const c = shadow.slice();
    _internPrehashed(c, _arrayHashOf(N, (accInfo.a + i) >>> 0), (accInfo.a + i) >>> 0, N);
  },
  'produce': (i) => vProduce(base, (d) => { d.arr[mid].value = i; }),
};
const fn = variants[which];
for (let i = 0; i < 200; i++) fn(i);
await yieldTask();
const t0 = process.hrtime.bigint();
for (let i = 0; i < ITER; i++) { fn(i); await yieldTask(); }
const total = Number(process.hrtime.bigint() - t0) / ITER / 1000;
const y0 = process.hrtime.bigint();
for (let i = 0; i < ITER; i++) await yieldTask();
const yieldCost = Number(process.hrtime.bigint() - y0) / ITER / 1000;
console.log(`${which.padEnd(26)} ${(total - yieldCost).toFixed(1).padStart(7)} µs/op`);
