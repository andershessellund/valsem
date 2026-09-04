// Retention-pattern benchmark — each section MUST run in a fresh process
// (node scripts/retention-bench.mjs A|B|C|D) to avoid heap cross-pollution.
import { produce as vProduce } from '../dist/produce.js';
import { intern } from '../dist/intern.js';
import { produce as iProduce, setAutoFreeze } from 'immer';
import { create as mCreate } from 'mutative';
setAutoFreeze(false); // immer's best case throughout

const N = 10000, ITER = 2000, mid = N >> 1;
const section = process.argv[2] ?? 'A';
function makeItems() {
  const a = new Array(N);
  for (let i = 0; i < N; i++) a[i] = { id: i, label: `item-${i}`, value: 0 };
  return a;
}
function t(name, fn, iter = ITER) {
  for (let i = 0; i < 200; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iter; i++) fn(i);
  console.log(`  ${name.padEnd(20)} ${(Number(process.hrtime.bigint() - t0) / iter / 1000).toFixed(1).padStart(7)} µs/op`);
}

if (section === 'A') {
  console.log('A. fixed base, result DISCARDED');
  const vb = intern({ arr: makeItems() });
  t('valsem', (i) => vProduce(vb, (d) => { d.arr[mid].value = i; }));
  const ibase = { arr: makeItems() };
  t('immer (no freeze)', (i) => iProduce(ibase, (d) => { d.arr[mid].value = i; }));
  const mb = { arr: makeItems() };
  t('mutative', (i) => mCreate(mb, (d) => { d.arr[mid].value = i; }));
} else if (section === 'B') {
  console.log('B. fixed base, result HELD in a 50-deep ring');
  const vb = intern({ arr: makeItems() }); const vr = new Array(50);
  t('valsem', (i) => { vr[i % 50] = vProduce(vb, (d) => { d.arr[mid].value = i; }); });
  const ibase = { arr: makeItems() }; const ir = new Array(50);
  t('immer (no freeze)', (i) => { ir[i % 50] = iProduce(ibase, (d) => { d.arr[mid].value = i; }); });
  const mbase = { arr: makeItems() }; const mr = new Array(50);
  t('mutative', (i) => { mr[i % 50] = mCreate(mbase, (d) => { d.arr[mid].value = i; }); });
} else if (section === 'C') {
  console.log('C. reducer chain: current = produce(current, ...), only current held');
  let vc = intern({ arr: makeItems() });
  t('valsem', (i) => { vc = vProduce(vc, (d) => { d.arr[(i * 37) % N].value = i; }); });
  let ic = { arr: makeItems() };
  t('immer (no freeze)', (i) => { ic = iProduce(ic, (d) => { d.arr[(i * 37) % N].value = i; }); });
  let mc = { arr: makeItems() };
  t('mutative', (i) => { mc = mCreate(mc, (d) => { d.arr[(i * 37) % N].value = i; }); });
} else {
  console.log('D. reducer chain + 50-state history ring');
  let vc = intern({ arr: makeItems() }); const vh = new Array(50);
  t('valsem', (i) => { vc = vProduce(vc, (d) => { d.arr[(i * 37) % N].value = i; }); vh[i % 50] = vc; });
  let ic = { arr: makeItems() }; const ih = new Array(50);
  t('immer (no freeze)', (i) => { ic = iProduce(ic, (d) => { d.arr[(i * 37) % N].value = i; }); ih[i % 50] = ic; });
  let mc = { arr: makeItems() }; const mh = new Array(50);
  t('mutative', (i) => { mc = mCreate(mc, (d) => { d.arr[(i * 37) % N].value = i; }); mh[i % 50] = mc; });
}

// Section E lives in the same file for shared setup; run: node ... E
if (section === 'E') {
  const { ValueList } = await import('../dist/value-list.js');
  console.log('E. reducer chain over { list: ValueList } — the designed shape');
  let vc = intern({ list: ValueList.from(Array.from({ length: N }, (_, i) => i)) });
  t('valsem ValueList', (i) => {
    vc = vProduce(vc, (d) => {
      d.list.set((i * 37) % N, i);
    });
  });
}
