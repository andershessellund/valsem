import { time, row } from '../lib.mjs';
import { memoize } from '../../dist/memoize.js';
import { intern } from '../../dist/intern.js';
import { ValueList } from '../../dist/value-list.js';

export default {
  id: 'memoize',
  title: 'memoize — hit and miss cost by argument kind',
  description: `
\`memoize\` keys on the argument tuple by content and interns results. The function is a selector over 100 records
(filter + map). Used as intended — canonical arguments, possibly with a small config literal built fresh beside them —
a hit is a cached-hash probe and \`===\` per argument. Handed raw payloads, it hashes and compares them structurally
on every call, which is the cost of skipping the boundary. The last rows isolate the hit cost against the width of
one raw record argument versus its canonical twin.
`,
  columns: ['per call'],
  unit: 'ns',
  rows() {
    const rows = [];
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, done: i % 3 === 0, text: `t${i}` }));
    const select = (filter, list) => list.filter((x) => (filter.done ? x.done : !x.done)).map((x) => x.text);
    const canonList = intern(items), canonFilter = intern({ done: true });
    const rawList = items.map((x) => ({ ...x }));
    const it = 200_000;
    rows.push(row('recompute, no memo', { 'per call': time(() => select({ done: true }, rawList), it) }));
    { const m = memoize(select); rows.push(row('hit, both arguments canonical', { 'per call': time(() => m(canonFilter, canonList), it) })); }
    { const m = memoize(select); rows.push(row('hit, fresh filter literal + canonical list (the reselect case)', { 'per call': time(() => m({ done: true }, canonList), it) })); }
    { const vl = ValueList.from(items); const m = memoize((f, list) => list.toArray().filter((x) => (f.done ? x.done : !x.done)).map((x) => x.text)); rows.push(row('hit, fresh filter literal + ValueList', { 'per call': time(() => m({ done: true }, vl), it) })); }
    { const m = memoize(select); rows.push(row('hit, both arguments raw (100 × 3-key records)', { 'per call': time(() => m({ done: true }, rawList), 20_000) })); }
    { const m = memoize((f) => select(f, canonList), { maxSize: 8 }); const fs = Array.from({ length: 8 }, (_, i) => intern({ done: i % 2 === 0, n: i })); rows.push(row('hit, maxSize 8, working set of 8', { 'per call': time((i) => m(fs[i & 7]), it) })); }
    { const m = memoize((f) => select(f, canonList), { maxSize: 8 }); const fs = Array.from({ length: 9 }, (_, i) => intern({ done: i % 2 === 0, n: i })); rows.push(row('miss + evict, maxSize 8, working set of 9', { 'per call': time((i) => m(fs[i % 9]), it) })); }
    const rec = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    for (const n of [3, 20, 200]) {
      const m = memoize((r) => r.k0);
      const a = rec(n), b = rec(n);
      rows.push(row(`hit, one raw ${n}-key record argument`, { 'per call': time((i) => m(i & 1 ? a : b), it) }));
      const m2 = memoize((r) => r.k0);
      const c = intern(rec(n));
      rows.push(row(`hit, one canonical ${n}-key record argument`, { 'per call': time(() => m2(c), it) }));
    }
    return rows;
  },
};
