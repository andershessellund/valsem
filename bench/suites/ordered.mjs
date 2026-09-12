import { time, row, assertEq } from '../lib.mjs';
import { OrderedMap } from '../../dist/ordered-map.js';
import { OrderedSet } from '../../dist/ordered-set.js';
import { produce } from '../../dist/produce.js';
import { deepEqual } from '../../dist/deep-equal.js';
import { OrderedMap as IOMap, OrderedSet as IOSet, is as iIs } from 'immutable';

export default {
  id: 'ordered',
  title: 'OrderedMap, OrderedSet — against Immutable.js',
  description: `
Insertion-ordered collections with canonical instances. Immutable's \`OrderedMap\` keeps a map from key to list
index and leaves holes in the list on delete, compacting when holes outnumber entries — a representation that
depends on delete history, which hash consing cannot allow. valsem keeps, per key, one content-derived ANCHOR
(the first element of the run the key sits in — or, for a key that starts its run, of the lowest enclosing run it
does not start) in the key trie, and finds a key's position through it in O(log n); the price is anchor maintenance
on the runs an edit re-chunks. Primitive keys and values, so
intern-on-entry is a no-op and the structures are what is timed; every row asserts both libraries agree.

- **build**, **get**, **set existing** (novel value), **append** (a new key), **delete** (a middle key),
  **indexOf** (Immutable: \`keySeq().indexOf\`, a scan), **insert at n/2** (valsem only — Immutable has no positional
  insert), **iterate**.
- **equals =**: two independently built equal maps — valsem's pointer compare; Immutable's \`is()\` walks.
- **draft, k edits**: one \`produce\` with k sets on present keys and k/10 deletes, against \`withMutations\`.
`,
  columns: ['valsem', 'Immutable'],
  unit: 'ns',
  ratio: ['valsem', 'Immutable'],
  rows() {
    const rows = [];
    const cmp = (name, val, imm, it, check) => {
      it = Math.max(20, Math.round(it));
      if (check) check(val(0), imm === null ? undefined : imm(0));
      rows.push(row(name, { valsem: time(val, it), Immutable: imm === null ? null : time(imm, it) }));
    };
    for (const N of [100, 10_000]) {
      const entries = Array.from({ length: N }, (_, i) => [`k${i}`, i]);
      const keys = entries.map(([k]) => k);
      const vm = OrderedMap.from(entries), im = IOMap(entries);
      let chain = OrderedMap.empty();
      let ichain = IOMap();
      for (const [k, v] of entries) {
        chain = chain.set(k, v);
        ichain = ichain.set(k, v);
      }
      // Structural rows allocate re-chunked leaves per iteration, and V8 keeps every
      // dereferenced WeakRef target alive to the end of the job: keep the counts modest.
      const perOp = 200_000 / Math.log2(N + 2), perEdit = perOp / 4, perWalk = Math.max(20, 100_000 / N);
      const mid = N >> 1;
      const t = `OrderedMap ${N}`;
      cmp(`${t}: build from entries`, () => OrderedMap.from(entries).size, () => IOMap(entries).size, perWalk, assertEq);
      cmp(`${t}: get`, (i) => vm.get(keys[i % N]), (i) => im.get(keys[i % N]), perOp, assertEq);
      cmp(`${t}: set existing key → novel value`, (i) => vm.set(keys[i % N], -i).size, (i) => im.set(keys[i % N], -i).size, perEdit, assertEq);
      cmp(`${t}: append a new key`, (i) => vm.set('new' + i, i).size, (i) => im.set('new' + i, i).size, perEdit, assertEq);
      cmp(`${t}: delete a middle key`, (i) => vm.delete(keys[(mid + i) % N]).size, (i) => im.delete(keys[(mid + i) % N]).size, perEdit, assertEq);
      cmp(`${t}: indexOf a middle key`, (i) => vm.indexOf(keys[(mid + i) % N]), (i) => im.keySeq().indexOf(keys[(mid + i) % N]), perOp, assertEq);
      cmp(`${t}: insert at n/2`, (i) => vm.insertAt(mid, 'new' + i, i).size, null, perEdit);
      cmp(`${t}: iterate entries`, () => { let s = 0; for (const [, v] of vm) s += v; return s; }, () => { let s = 0; for (const [, v] of im) s += v; return s; }, perWalk, assertEq);
      cmp(`${t}: equals = (from vs set chain)`, () => deepEqual(vm, chain), () => iIs(im, ichain), perWalk * 4, (a, b) => { assertEq(a, true); assertEq(b, true); });
      for (const k of N === 100 ? [10] : [10, 100]) {
        const idx = Array.from({ length: k }, (_, j) => Math.floor((j * N) / k));
        const del = idx.filter((_, j) => j % 10 === 0).map((i) => keys[(i + 1) % N]);
        const it = Math.max(20, 4_000 / k);
        cmp(
          `${t}: draft, ${k} sets + ${del.length} deletes`,
          (i) => produce(vm, (d) => { for (const j of idx) d.set(keys[j], -i); for (const dk of del) d.delete(dk); }).size,
          (i) => im.withMutations((d) => { for (const j of idx) d.set(keys[j], -i); for (const dk of del) d.delete(dk); }).size,
          it,
          assertEq,
        );
      }
    }
    for (const N of [100, 10_000]) {
      const members = Array.from({ length: N }, (_, i) => `m${i}`);
      const vs = OrderedSet.from(members), is = IOSet(members);
      const perOp = 200_000 / Math.log2(N + 2), perEdit = perOp / 4, perWalk = Math.max(20, 100_000 / N);
      const mid = N >> 1;
      const t = `OrderedSet ${N}`;
      cmp(`${t}: build from members`, () => OrderedSet.from(members).size, () => IOSet(members).size, perWalk, assertEq);
      cmp(`${t}: has`, (i) => vs.has(members[i % N]), (i) => is.has(members[i % N]), perOp, assertEq);
      cmp(`${t}: add a new member`, (i) => vs.add('new' + i).size, (i) => is.add('new' + i).size, perEdit, assertEq);
      cmp(`${t}: delete a middle member`, (i) => vs.delete(members[(mid + i) % N]).size, (i) => is.delete(members[(mid + i) % N]).size, perEdit, assertEq);
      cmp(`${t}: indexOf a middle member`, (i) => vs.indexOf(members[(mid + i) % N]), (i) => is.toIndexedSeq().indexOf(members[(mid + i) % N]), perOp, assertEq);
      cmp(`${t}: iterate members`, () => { let n = 0; for (const m of vs) n += m.length; return n; }, () => { let n = 0; for (const m of is) n += m.length; return n; }, perWalk, assertEq);
    }
    return rows;
  },
};
