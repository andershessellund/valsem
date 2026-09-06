// ---------------------------------------------------------------------------
// list-bench — ValueList (the content-chunked tree) per operation, plus
// ValueList.diff vs a pointer scan. The radix vector it replaced was measured
// side by side at commit 7e7fa85; that table is in BENCHMARKS.md.
// Run: pnpm build && node scripts/list-bench.mjs [n]; also npx bun@latest …
// ---------------------------------------------------------------------------
import { ValueList } from '../dist/value-list.js';
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
const row = (name, a) => console.log(`  ${name.padEnd(34)} ${fmt(a).padStart(10)}`);
const row2 = (name, a, b) => console.log(`  ${name.padEnd(46)} ${fmt(a).padStart(10)} ${fmt(b).padStart(10)}   ${(b / a).toFixed(3)}×`);

const items = Array.from({ length: N }, (_, i) => ({ id: i, tag: `t${i % 7}`, v: i * 1.5 }));
const raw = items.map((x) => ({ ...x }));
console.log(`\n${rt} — ValueList, ${N} items`);
const canon = intern(items);
const vl = ValueList.from(canon);
console.log(`  (tree height ${vl._height})`);
row('from(raw items)', t(() => ValueList.from(raw), 5));
row('from(canonical items)', t(() => ValueList.from(canon), 5));
row('get(sequential)', t((i) => vl.get(i % N), 300000));
row('get(random)', t((i) => vl.get((i * 7919) % N), 300000));
row('iterate for…of', t(() => { let s = 0; for (const x of vl) s += x.id; return s; }, 20));
row('toArray() (ValueList memoizes)', t(() => vl.toArray().length, 20));
row('push', t((i) => vl.push({ id: -i }), 3000));
row('pop', t(() => vl.pop(), 3000));
row('set(mid)', t((i) => vl.set(N >> 1, { id: -i }), 3000));
row('insert at 0', t((i) => vl.insert(0, { id: -i }), 3000));
row('insert at mid', t((i) => vl.insert(N >> 1, { id: -i }), 3000));
row('remove at 0', t(() => vl.remove(0), 3000));
row('slice(n/4, 3n/4)', t(() => vl.slice(N >> 2, 3 * (N >> 2)), 3000));
const half = ValueList.from(items.slice(0, N >> 1)), half2 = ValueList.from(items.slice(N >> 1));
row('concat(two halves)', t(() => half.concat(half2), 3000));

console.log(`\n${rt} — diff, ${N} items                            pointer scan  ValueList.diff`);
const scan = (a, b) => { const x = a.toArray(), y = b.toArray(); let c = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) c++; return c; };
for (const c of [1, 10, 100]) {
  let edited = vl;
  for (let k = 0; k < c; k++) edited = edited.set(Math.floor((k + 0.5) * N / c), { id: -k });
  const vlEdited = ValueList.from(edited.toArray());
  const hunks = ValueList.diff(vl, edited);
  row2(`${String(c).padStart(3)} point edits (${hunks.length} hunks)`, t(() => scan(vl, vlEdited), 20), t(() => ValueList.diff(vl, edited), 2000));
}
{
  const ins = vl.insert(N >> 2, { id: -1 }).remove(3 * (N >> 2));
  const hunks = ValueList.diff(vl, ins);
  row2(`insert + remove (${hunks.length} hunks)`, t(() => scan(vl, ins), 20), t(() => ValueList.diff(vl, ins), 2000));
}
{
  // The refetch: an independently built list with 3 changed items.
  const changed = items.map((x, i) => (i % Math.floor(N / 3) === 7 ? { ...x, tag: 'changed' } : x));
  const refetched = ValueList.from(changed);
  const hunks = ValueList.diff(vl, refetched);
  row2(`refetch, 3 changed, unrelated build (${hunks.length} hunks)`, t(() => scan(vl, refetched), 20), t(() => ValueList.diff(vl, refetched), 2000));
}
