import { time, timeHeld, row } from '../lib.mjs';
import { produce as valsemProduce } from '../../dist/produce.js';
import { intern } from '../../dist/intern.js';
import { ValueMap } from '../../dist/value-map.js';
import { ValueList } from '../../dist/value-list.js';
import { produce as immerProduce, setAutoFreeze, enableMapSet } from 'immer';
import { create as mutativeCreate } from 'mutative';

enableMapSet();
const N = 10_000;
const makeItems = (n) => Array.from({ length: n }, (_, i) => ({ id: i, label: `item-${i}`, value: 0 }));
const C = { v: 'valsem', ion: 'immer (autofreeze on)', ioff: 'immer (autofreeze off)', m: 'mutative' };

export default {
  id: 'produce',
  title: 'produce — against immer and mutative',
  description: `
The update API, against the two libraries it is shaped after, at their shipped defaults plus immer with
auto-freeze off. Every iteration produces a **novel** state (the value written is the iteration counter),
except the recurrent row. Arenas:

- **big-array**: \`{ arr: [10,000 records] }\`, one record's field edited. *Synchronous* runs the produces back to
  back in one job — the regime that pays valsem's in-job WeakRef retention. *Held + macrotask* retains each result in
  a ring of 50 and runs one produce per macrotask, the regime a UI actually runs.
- **wide-record**: a 1,000-key record (built with \`Object.fromEntries\`, so the fixture is in fast-properties mode),
  one value edited. Every library's copy site is megamorphic by the time this arena runs, which is the honest state
  of a copy site in an application.
- **value-map / value-list**: a 10,000-entry \`ValueMap\` / 10,000-element \`ValueList\` edited through its draft
  (immer and mutative draft a native \`Map\` / array), and the same edit as a direct persistent operation.
- **small-churn**: a 3-key record, one field — the per-op floor.
- **recurrent**: the big-array arena cycling through 10 configurations, results held — the arena where a successor
  is a pure function of (canonical base, exact delta) and comes back pointer-identical.
`,
  columns: [C.v, C.ion, C.ioff, C.m],
  unit: 'ns',
  async rows() {
    const rows = [];
    let seq = 0;
    const novel = () => ++seq;
    {
      const mid = N >> 1;
      const vb = intern({ arr: makeItems(N) });
      // immer's auto-freeze setting is global and a base produced under it is deeply frozen;
      // the "off" contender gets a base produced with it off, as its users would have.
      setAutoFreeze(true);
      const ib = immerProduce({ arr: makeItems(N) }, () => {});
      setAutoFreeze(false);
      const ib2 = immerProduce({ arr: makeItems(N) }, () => {});
      setAutoFreeze(true);
      const mb = { arr: makeItems(N) };
      const it = 2000;
      const v = time(() => valsemProduce(vb, (d) => { d.arr[mid].value = novel(); }), it);
      setAutoFreeze(true);
      const ion = time(() => immerProduce(ib, (d) => { d.arr[mid].value = novel(); }), 300);
      setAutoFreeze(false);
      const ioff = time(() => immerProduce(ib2, (d) => { d.arr[mid].value = novel(); }), it);
      setAutoFreeze(true);
      const m = time(() => mutativeCreate(mb, (d) => { d.arr[mid].value = novel(); }), it);
      rows.push(row('big-array 10k, one edit, synchronous loop', { [C.v]: v, [C.ion]: ion, [C.ioff]: ioff, [C.m]: m }));
      const vh = await timeHeld(() => valsemProduce(vb, (d) => { d.arr[mid].value = novel(); }), it);
      setAutoFreeze(false);
      const ih = await timeHeld(() => immerProduce(ib2, (d) => { d.arr[mid].value = novel(); }), it);
      setAutoFreeze(true);
      const mh = await timeHeld(() => mutativeCreate(mb, (d) => { d.arr[mid].value = novel(); }), it);
      rows.push(row('big-array 10k, one edit, held + one per macrotask', { [C.v]: vh, [C.ion]: null, [C.ioff]: ih, [C.m]: mh }));
    }
    {
      const rec = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`key${i}`, i]));
      const vb = intern(rec);
      setAutoFreeze(true);
      const ib = immerProduce({ ...rec }, () => {});
      setAutoFreeze(false);
      const ib2 = immerProduce({ ...rec }, () => {});
      setAutoFreeze(true);
      const mb = { ...rec };
      const it = 2000;
      const v = time(() => valsemProduce(vb, (d) => { d.key500 = novel(); }), it);
      setAutoFreeze(true);
      const ion = time(() => immerProduce(ib, (d) => { d.key500 = novel(); }), it);
      setAutoFreeze(false);
      const ioff = time(() => immerProduce(ib2, (d) => { d.key500 = novel(); }), it);
      setAutoFreeze(true);
      const m = time(() => mutativeCreate(mb, (d) => { d.key500 = novel(); }), it);
      rows.push(row('wide-record 1000 keys, one edit', { [C.v]: v, [C.ion]: ion, [C.ioff]: ioff, [C.m]: m }));
    }
    {
      const entries = Array.from({ length: N }, (_, i) => [`k${i}`, i]);
      const vb = ValueMap.from(entries);
      const ib = immerProduce(new Map(entries), () => {});
      const mb = new Map(entries);
      const it = 2000;
      rows.push(row('value-map 10k, one set, through the draft', {
        [C.v]: time(() => valsemProduce(vb, (d) => { d.set('k5', novel()); }), it),
        [C.ion]: time(() => immerProduce(ib, (d) => { d.set('k5', novel()); }), 300),
        [C.ioff]: null,
        [C.m]: time(() => mutativeCreate(mb, (d) => { d.set('k5', novel()); }), 300),
      }));
      rows.push(row('value-map 10k, one set, direct persistent op', { [C.v]: time(() => vb.set('k5', novel()), it), [C.ion]: null, [C.ioff]: null, [C.m]: null }));
    }
    {
      const nums = Array.from({ length: N }, (_, i) => i);
      const mid = N >> 1;
      const vb = ValueList.from(nums);
      const ib = nums.slice();
      const mb = nums.slice();
      const it = 2000;
      const v = time(() => valsemProduce(vb, (d) => { d.set(mid, novel()); d.push(novel()); }), it);
      setAutoFreeze(false);
      const ioff = time(() => immerProduce(ib, (d) => { d[mid] = novel(); d.push(novel()); }), it);
      setAutoFreeze(true);
      const m = time(() => mutativeCreate(mb, (d) => { d[mid] = novel(); d.push(novel()); }), it);
      rows.push(row('value-list 10k, set + push, through the draft', { [C.v]: v, [C.ion]: null, [C.ioff]: ioff, [C.m]: m }));
      rows.push(row('value-list 10k, set + push, direct persistent ops', { [C.v]: time(() => vb.set(mid, novel()).push(novel()), it), [C.ion]: null, [C.ioff]: null, [C.m]: null }));
    }
    {
      const vb = intern({ x: 1, y: 2, z: 3 });
      const it = 200_000;
      const v = time(() => valsemProduce(vb, (d) => { d.x = novel(); }), it);
      setAutoFreeze(true);
      const ion = time(() => immerProduce({ x: 1, y: 2, z: 3 }, (d) => { d.x = novel(); }), it);
      setAutoFreeze(false);
      const ioff = time(() => immerProduce({ x: 1, y: 2, z: 3 }, (d) => { d.x = novel(); }), it);
      setAutoFreeze(true);
      const m = time(() => mutativeCreate({ x: 1, y: 2, z: 3 }, (d) => { d.x = novel(); }), it);
      rows.push(row('small-churn 3-key record, one field', { [C.v]: v, [C.ion]: ion, [C.ioff]: ioff, [C.m]: m }));
    }
    {
      const mid = N >> 1;
      const vb = intern({ arr: makeItems(N) });
      setAutoFreeze(true);
      const ib = immerProduce({ arr: makeItems(N) }, () => {});
      setAutoFreeze(false);
      const ib2 = immerProduce({ arr: makeItems(N) }, () => {});
      setAutoFreeze(true);
      const mb = { arr: makeItems(N) };
      const held = [];
      const it = 2000;
      const v = time((i) => { held[i % 10] = valsemProduce(vb, (d) => { d.arr[mid].value = i % 10; }); }, it);
      setAutoFreeze(true);
      const ion = time((i) => { held[i % 10] = immerProduce(ib, (d) => { d.arr[mid].value = i % 10; }); }, 300);
      setAutoFreeze(false);
      const ioff = time((i) => { held[i % 10] = immerProduce(ib2, (d) => { d.arr[mid].value = i % 10; }); }, it);
      setAutoFreeze(true);
      const m = time((i) => { held[i % 10] = mutativeCreate(mb, (d) => { d.arr[mid].value = i % 10; }); }, it);
      rows.push(row('recurrent: big-array cycling 10 configurations, held', { [C.v]: v, [C.ion]: ion, [C.ioff]: ioff, [C.m]: m }, 'valsem returns 10 pooled instances; equality afterwards is ==='));
    }
    return rows;
  },
};
