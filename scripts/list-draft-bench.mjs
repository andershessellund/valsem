// ---------------------------------------------------------------------------
// list-draft-bench — batched updates through produce() on ValueList's
// DraftList (the chunked draft, which never materialises). The radix-vector
// draft it replaced was measured side by side at commit 7e7fa85 (BENCHMARKS.md).
// Run: pnpm build && node scripts/list-draft-bench.mjs [n]; also npx bun@latest …
// ---------------------------------------------------------------------------
import { ValueList } from '../dist/value-list.js';
import { produce } from '../dist/produce.js';
import { intern } from '../dist/intern.js';

const N = Number(process.argv[2] ?? 100_000);
const rt = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
function t(fn, it) {
  for (let i = 0; i < Math.max(3, it / 5); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / it / 1000;
}
const fmt = (us) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : us >= 10 ? `${us.toFixed(1)} µs` : `${(us * 1000).toFixed(0)} ns`);
const row = (name, a) => console.log(`  ${name.padEnd(44)} ${fmt(a).padStart(10)}`);
const items = intern(Array.from({ length: N }, (_, i) => ({ id: i, tag: `t${i % 7}`, v: 0 })));
const vl = ValueList.from(items);
let seq = 0;
console.log(`\n${rt} — produce over a ${N}-item ValueList`);
row('1 set', t(() => produce(vl, (d) => { d.set(N >> 1, { id: -1, v: ++seq }); }), 2000));
row('1 nested edit (get(i).v = x)', t(() => produce(vl, (d) => { d.get(N >> 1).v = ++seq; }), 2000));
row('100 sets, spread out', t(() => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.set(k * (N / 100) | 0, { id: -k, v: ++seq }); }), 200));
row('100 nested edits, spread out', t(() => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.get(k * (N / 100) | 0).v = ++seq; }), 200));
row('push 100', t(() => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.push({ id: -k, v: ++seq }); }), 200));
row('1 insert at n/2', t(() => produce(vl, (d) => { d.splice(N >> 1, 0, { id: -1, v: ++seq }); }), 10));
row('10 inserts + 10 removes, spread out', t(() => produce(vl, (d) => { for (let k = 0; k < 10; k++) { d.splice(k * (N / 10) | 0, 0, { id: -k, v: ++seq }); d.splice((k * (N / 10) | 0) + 5, 1); } }), 10));
row('100 sets + 10 inserts + 10 removes', t(() => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.set(k * (N / 100) | 0, { id: -k, v: ++seq }); for (let k = 0; k < 10; k++) { d.splice(k * (N / 10) | 0, 0, { id: -k, v: ++seq }); d.splice((k * (N / 10) | 0) + 5, 1); } }), 10));
row('splice 1000 out of the middle', t(() => produce(vl, (d) => { d.splice(N >> 1, 1000); }), 10));
row('reverse-ish: pop 100 then push 100', t(() => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.pop(); for (let k = 0; k < 100; k++) d.push({ id: -k, v: ++seq }); }), 200));
console.log(`\n  direct persistent ops for reference: set ${fmt(t((i) => vl.set(N >> 1, { id: -1, v: i }), 3000))}, insert ${fmt(t((i) => vl.insert(N >> 1, { id: -1, v: i }), 3000))}`);
