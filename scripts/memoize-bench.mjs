// ---------------------------------------------------------------------------
// memoize-bench — what a structural memo hit costs, by argument kind.
//
// The rule is deepEqual's: canonical arguments hit in O(1) (cached hash,
// `===` equality); raw arguments are hashed and compared structurally on
// every call, so on raw data memoization wins only when the function costs
// more than a walk of its arguments.
//
// Run: pnpm build && node scripts/memoize-bench.mjs
// ---------------------------------------------------------------------------
import { memoize } from '../dist/memoize.js';
import { intern } from '../dist/intern.js';
import { ValueList } from '../dist/value-list.js';

function t(fn, it = 200000) {
  for (let i = 0; i < 20000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / it;
}
const row = (name, ns) => console.log(`  ${name.padEnd(46)} ${ns.toFixed(0).padStart(7)} ns`);
const rec = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

const items = Array.from({ length: 100 }, (_, i) => ({ id: i, done: i % 3 === 0, text: `t${i}` }));
const select = (filter, list) => list.filter((x) => (filter.done ? x.done : !x.done)).map((x) => x.text);
const canonList = intern(items);
const canonFilter = intern({ done: true });
const rawList = items.map((x) => ({ ...x }));

console.log('\nselector over 100 items, filter + map');
row('recompute, no memo', t(() => select({ done: true }, rawList)));
{
  const m = memoize(select);
  row('hit, both arguments canonical', t(() => m(canonFilter, canonList)));
}
{
  const m = memoize(select);
  row('hit, fresh filter literal + canonical list', t(() => m({ done: true }, canonList)));
}
{
  const m = memoize(select);
  row('hit, both arguments raw (100 × 3-key records)', t(() => m({ done: true }, rawList), 20000));
}
{
  const vl = ValueList.from(items);
  const m = memoize((f, list) => list.toArray().filter((x) => (f.done ? x.done : !x.done)).map((x) => x.text));
  row('hit, fresh filter literal + ValueList', t(() => m({ done: true }, vl)));
}
{
  const m = memoize((f) => select(f, canonList), { maxSize: 8 });
  const filters = Array.from({ length: 8 }, (_, i) => intern({ done: i % 2 === 0, n: i }));
  row('hit, maxSize 8, working set of 8', t((i) => m(filters[i & 7])));
}
{
  const m = memoize((f) => select(f, canonList), { maxSize: 8 });
  const filters = Array.from({ length: 9 }, (_, i) => intern({ done: i % 2 === 0, n: i }));
  row('miss + evict, maxSize 8, working set of 9', t((i) => m(filters[i % 9])));
}

console.log('\nhit cost by raw argument width (one record argument)');
for (const n of [3, 20, 200]) {
  const m = memoize((r) => r.k0);
  const a = rec(n), b = rec(n);
  row(`raw ${String(n).padStart(3)}-key record`, t((i) => m(i & 1 ? a : b)));
  const m2 = memoize((r) => r.k0);
  const c = intern(rec(n));
  row(`canonical ${String(n).padStart(3)}-key record`, t(() => m2(c)));
}
