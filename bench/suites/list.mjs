import { time, row } from '../lib.mjs';
import { ValueList } from '../../dist/value-list.js';
import { intern } from '../../dist/intern.js';

const N = 100_000;

export default {
  id: 'list',
  title: 'ValueList — operations and diff at 100k elements',
  description: `
\`ValueList\` is a content-chunked, hash-consed tree with the open last run kept in a tail array. A leaf boundary
falls after any element whose seeded hash says so (1 in 32; runs cap at 64), and branch runs follow the same rule on
node hashes, so the shape is a function of the content alone and an edit re-chunks only the runs around it. The first
block times each operation on a 100,000-record list (records canonical). The second block times
\`ValueList.diff(a, b)\` against a pointer scan over both \`toArray()\` snapshots (elements are canonical, so the scan
is already the cheap comparison): c point edits, an insert plus a remove, and a *refetch* — an independently built
list with three changed records, which shares nothing by lineage with the original.
`,
  columns: ['ValueList', 'pointer scan'],
  unit: 'ns',
  rows() {
    const rows = [];
    const items = Array.from({ length: N }, (_, i) => ({ id: i, tag: `t${i % 7}`, v: i * 1.5 }));
    const raw = items.map((x) => ({ ...x }));
    const canon = intern(items);
    const vl = ValueList.from(canon);
    const op = (name, v) => rows.push(row(name, { ValueList: v, 'pointer scan': null }));
    op('from, raw records (admission dominates)', time(() => ValueList.from(raw), 5));
    op('from, canonical records', time(() => ValueList.from(canon), 5));
    op('get, sequential', time((i) => vl.get(i % N), 300_000));
    op('get, random', time((i) => vl.get((i * 7919) % N), 300_000));
    op('iterate for…of', time(() => { let s = 0; for (const x of vl) s += x.id; return s; }, 20));
    op('toArray (memoized)', time(() => vl.toArray().length, 20));
    op('push', time((i) => vl.push({ id: -i }), 3000));
    op('pop', time(() => vl.pop(), 3000));
    op('set, middle', time((i) => vl.set(N >> 1, { id: -i }), 3000));
    op('insert at 0', time((i) => vl.insert(0, { id: -i }), 3000));
    op('insert, middle', time((i) => vl.insert(N >> 1, { id: -i }), 3000));
    op('remove at 0', time(() => vl.remove(0), 3000));
    op('slice, middle half', time(() => vl.slice(N >> 2, 3 * (N >> 2)), 3000));
    const half = ValueList.from(items.slice(0, N >> 1)), half2 = ValueList.from(items.slice(N >> 1));
    op('concat, two halves', time(() => half.concat(half2), 3000));
    const scan = (a, b) => { const x = a.toArray(), y = b.toArray(); let c = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) c++; return c; };
    for (const c of [1, 10, 100]) {
      let edited = vl;
      for (let k = 0; k < c; k++) edited = edited.set(Math.floor(((k + 0.5) * N) / c), { id: -k });
      const hunks = ValueList.diff(vl, edited).length;
      rows.push(row(`diff: ${c} point edit${c > 1 ? 's' : ''} (${hunks} hunks)`, { ValueList: time(() => ValueList.diff(vl, edited), 2000), 'pointer scan': time(() => scan(vl, edited), 20) }));
    }
    {
      const ins = vl.insert(N >> 2, { id: -1 }).remove(3 * (N >> 2));
      rows.push(row(`diff: insert + remove (${ValueList.diff(vl, ins).length} hunks)`, { ValueList: time(() => ValueList.diff(vl, ins), 2000), 'pointer scan': time(() => scan(vl, ins), 20) }));
    }
    {
      const changed = items.map((x, i) => (i % Math.floor(N / 3) === 7 ? { ...x, tag: 'changed' } : x));
      const refetched = ValueList.from(changed);
      rows.push(row(`diff: refetch, 3 changed, independently built (${ValueList.diff(vl, refetched).length} hunks)`, { ValueList: time(() => ValueList.diff(vl, refetched), 2000), 'pointer scan': time(() => scan(vl, refetched), 20) }));
    }
    return rows;
  },
};
