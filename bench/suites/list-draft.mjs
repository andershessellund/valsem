import { time, row } from '../lib.mjs';
import { ValueList } from '../../dist/value-list.js';
import { produce } from '../../dist/produce.js';
import { intern } from '../../dist/intern.js';

const N = 100_000;

export default {
  id: 'list-draft',
  title: 'ValueList inside produce — batched updates',
  description: `
One \`produce\` per row over a 100,000-record \`ValueList\`, through its draft. The draft never materialises: structural
ops go to a persistent working list as they happen, point edits and child drafts sit in an overlay by current index,
pushes wait in a tail, and finalize applies the overlay with \`setMany\` (one bottom-up pass that rebuilds each touched
leaf and ancestor once) and the tail as one splice. The last row is the direct persistent operations for reference.
`,
  columns: ['per produce'],
  unit: 'ns',
  rows() {
    const rows = [];
    const items = intern(Array.from({ length: N }, (_, i) => ({ id: i, tag: `t${i % 7}`, v: 0 })));
    const vl = ValueList.from(items);
    let seq = 0;
    const r = (name, fn, it) => rows.push(row(name, { 'per produce': time(fn, it) }));
    r('1 set', () => produce(vl, (d) => { d.set(N >> 1, { id: -1, v: ++seq }); }), 2000);
    r('1 nested edit (get(i).v = x)', () => produce(vl, (d) => { d.get(N >> 1).v = ++seq; }), 2000);
    r('100 sets, spread out', () => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.set((k * (N / 100)) | 0, { id: -k, v: ++seq }); }), 200);
    r('100 nested edits, spread out', () => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.get((k * (N / 100)) | 0).v = ++seq; }), 200);
    r('push 100', () => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.push({ id: -k, v: ++seq }); }), 200);
    r('1 insert at n/2', () => produce(vl, (d) => { d.splice(N >> 1, 0, { id: -1, v: ++seq }); }), 2000);
    r('10 inserts + 10 removes, spread out', () => produce(vl, (d) => { for (let k = 0; k < 10; k++) { d.splice((k * (N / 10)) | 0, 0, { id: -k, v: ++seq }); d.splice(((k * (N / 10)) | 0) + 5, 1); } }), 500);
    r('100 sets + 10 inserts + 10 removes', () => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.set((k * (N / 100)) | 0, { id: -k, v: ++seq }); for (let k = 0; k < 10; k++) { d.splice((k * (N / 10)) | 0, 0, { id: -k, v: ++seq }); d.splice(((k * (N / 10)) | 0) + 5, 1); } }), 200);
    r('splice 1,000 out of the middle', () => produce(vl, (d) => { d.splice(N >> 1, 1000); }), 500);
    r('pop 100 then push 100', () => produce(vl, (d) => { for (let k = 0; k < 100; k++) d.pop(); for (let k = 0; k < 100; k++) d.push({ id: -k, v: ++seq }); }), 200);
    r('reference: direct set', (i) => vl.set(N >> 1, { id: -1, v: i }), 3000);
    r('reference: direct insert', (i) => vl.insert(N >> 1, { id: -1, v: i }), 3000);
    return rows;
  },
};
