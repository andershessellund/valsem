import { time, row, shuffled, assertEq } from '../lib.mjs';
import { ValueMap } from '../../dist/value-map.js';
import { ValueSet } from '../../dist/value-set.js';
import { ValueList } from '../../dist/value-list.js';
import { deepEqual } from '../../dist/deep-equal.js';
import { deepHash } from '../../dist/deep-hash.js';
import { Map as IMap, Set as ISet, List as IList, is as iIs, hash as iHash } from 'immutable';

export default {
  id: 'collections',
  title: 'ValueMap, ValueSet, ValueList — against Immutable.js',
  description: `
The closest structural comparison: Immutable's \`Map\`/\`Set\` are HAMTs like valsem's; its \`List\` is a 32-way
radix vector, which valsem's \`ValueList\` was until it became a content-chunked tree. Primitive keys and values, so
intern-on-entry is a no-op and the trie work is what is timed; every row asserts both libraries agree. Per structure,
at N = 100 and N = 10,000:

- **build**, **get / has** (hit and miss), **set / add** (an existing key with a novel value, and a new key),
  **delete**, **iterate**.
- **update then hash**: one persistent update, then the hash of the successor — valsem pays hashing inside the update
  (consing), Immutable lazily on the first \`hashCode()\`.
- **equals =**: two independently built equal collections (shuffled insertion; for lists, \`from\` vs a push chain) —
  valsem's \`deepEqual\` is the \`[interned]\` short-circuit, Immutable's \`is()\` walks.
- **equals ≠**: equal but for one entry — cold, and again with Immutable's per-instance hash cache warmed, where
  \`is()\` short-circuits on differing cached hashes (an *equal* pair must still walk).

The last rows use record values, where the semantics differ by design: valsem canonicalises and freezes each record
(equal-content records are one instance and equal maps are the same object); Immutable stores references.
`,
  columns: ['valsem', 'Immutable'],
  unit: 'ns',
  ratio: ['valsem', 'Immutable'],
  rows() {
    const rows = [];
    const cmp = (name, val, imm, it, check) => {
      it = Math.max(50, Math.round(it));
      if (check) check(val(0), imm(0));
      rows.push(row(name, { valsem: time(val, it), Immutable: time(imm, it) }));
    };
    const both = (expected) => (a, b) => { assertEq(a, expected); assertEq(b, expected); };
    for (const N of [100, 10_000]) {
      const entries = Array.from({ length: N }, (_, i) => [`k${i}`, i]);
      const keys = entries.map(([k]) => k);
      const vm = ValueMap.from(entries), im = IMap(entries);
      const vm2 = ValueMap.from(shuffled(entries)), im2 = IMap(shuffled(entries));
      const oneOff = entries.map(([k, v], i) => (i === N >> 1 ? [k, -1] : [k, v]));
      const vmDiff = ValueMap.from(oneOff), imDiff = IMap(oneOff);
      const perOp = 2_000_000 / Math.log2(N + 2), perWalk = Math.max(20, 400_000 / N);
      const t = `Map ${N}`;
      cmp(`${t}: build from entries`, () => ValueMap.from(entries).size, () => IMap(entries).size, perWalk, assertEq);
      cmp(`${t}: get (hit)`, (i) => vm.get(keys[i % N]), (i) => im.get(keys[i % N]), perOp, assertEq);
      cmp(`${t}: has (miss)`, (i) => vm.has('nope' + (i % N)), (i) => im.has('nope' + (i % N)), perOp, assertEq);
      cmp(`${t}: set existing key → novel value`, (i) => vm.set(keys[i % N], -i).size, (i) => im.set(keys[i % N], -i).size, perOp, assertEq);
      cmp(`${t}: set new key`, (i) => vm.set('new' + i, i).size, (i) => im.set('new' + i, i).size, perOp, assertEq);
      cmp(`${t}: delete existing`, (i) => vm.delete(keys[i % N]).size, (i) => im.delete(keys[i % N]).size, perOp, assertEq);
      cmp(`${t}: iterate entries`, () => { let s = 0; for (const [, v] of vm) s += v; return s; }, () => { let s = 0; for (const [, v] of im) s += v; return s; }, perWalk, assertEq);
      cmp(`${t}: set one key, then hash`, (i) => deepHash(vm.set(keys[i % N], -i)), (i) => iHash(im.set(keys[i % N], -i)), Math.max(50, 200_000 / N), (a, b) => assertEq(typeof a, typeof b));
      cmp(`${t}: equals = (independent builds)`, () => deepEqual(vm, vm2), () => iIs(im, im2), perWalk * 4, both(true));
      cmp(`${t}: equals ≠ (one entry differs), cold`, () => deepEqual(vm, vmDiff), () => iIs(im, imDiff), perWalk * 4, both(false));
      iHash(im); iHash(imDiff);
      cmp(`${t}: equals ≠, Immutable hashes warmed`, () => deepEqual(vm, vmDiff), () => iIs(im, imDiff), perOp, both(false));
    }
    for (const N of [100, 10_000]) {
      const members = Array.from({ length: N }, (_, i) => `m${i}`);
      const vs = ValueSet.from(members), is = ISet(members);
      const vs2 = ValueSet.from(shuffled(members, 7)), is2 = ISet(shuffled(members, 7));
      const oneOff = members.map((m, i) => (i === N >> 1 ? 'other' : m));
      const vsDiff = ValueSet.from(oneOff), isDiff = ISet(oneOff);
      const perOp = 2_000_000 / Math.log2(N + 2), perWalk = Math.max(20, 400_000 / N);
      const t = `Set ${N}`;
      cmp(`${t}: build from members`, () => ValueSet.from(members).size, () => ISet(members).size, perWalk, assertEq);
      cmp(`${t}: has (hit)`, (i) => vs.has(members[i % N]), (i) => is.has(members[i % N]), perOp, assertEq);
      cmp(`${t}: add new member`, (i) => vs.add('new' + i).size, (i) => is.add('new' + i).size, perOp, assertEq);
      cmp(`${t}: delete existing`, (i) => vs.delete(members[i % N]).size, (i) => is.delete(members[i % N]).size, perOp, assertEq);
      cmp(`${t}: iterate members`, () => { let n = 0; for (const m of vs) n += m.length; return n; }, () => { let n = 0; for (const m of is) n += m.length; return n; }, perWalk, assertEq);
      cmp(`${t}: add one member, then hash`, (i) => deepHash(vs.add('new' + i)), (i) => iHash(is.add('new' + i)), Math.max(50, 200_000 / N), (a, b) => assertEq(typeof a, typeof b));
      cmp(`${t}: equals = (independent builds)`, () => deepEqual(vs, vs2), () => iIs(is, is2), perWalk * 4, both(true));
      cmp(`${t}: equals ≠ (one member differs), cold`, () => deepEqual(vs, vsDiff), () => iIs(is, isDiff), perWalk * 4, both(false));
      iHash(is); iHash(isDiff);
      cmp(`${t}: equals ≠, Immutable hashes warmed`, () => deepEqual(vs, vsDiff), () => iIs(is, isDiff), perOp, both(false));
    }
    for (const N of [100, 10_000]) {
      const arr = Array.from({ length: N }, (_, i) => i);
      const vl = ValueList.from(arr), il = IList(arr);
      let vl2 = ValueList.empty(), il2 = IList();
      for (const x of arr) { vl2 = vl2.push(x); il2 = il2.push(x); }
      const oneOff = arr.map((x, i) => (i === N >> 1 ? -1 : x));
      const vlDiff = ValueList.from(oneOff), ilDiff = IList(oneOff);
      const perOp = 2_000_000 / Math.log2(N + 2), perWalk = Math.max(20, 400_000 / N);
      const mid = N >> 1;
      const t = `List ${N}`;
      cmp(`${t}: build from array`, () => ValueList.from(arr).length, () => IList(arr).size, perWalk, assertEq);
      cmp(`${t}: get (mid index)`, (i) => vl.get((mid + i) % N), (i) => il.get((mid + i) % N), perOp, assertEq);
      cmp(`${t}: set (mid) → novel value`, (i) => vl.set(mid, -i).get(mid), (i) => il.set(mid, -i).get(mid), perOp, assertEq);
      cmp(`${t}: push`, (i) => vl.push(i).length, (i) => il.push(i).size, perOp, assertEq);
      cmp(`${t}: pop`, () => vl.pop().length, () => il.pop().size, perOp, assertEq);
      cmp(`${t}: iterate elements`, () => { let s = 0; for (const x of vl) s += x; return s; }, () => { let s = 0; for (const x of il) s += x; return s; }, perWalk, assertEq);
      cmp(`${t}: push one, then hash`, (i) => deepHash(vl.push(i)), (i) => iHash(il.push(i)), Math.max(50, 200_000 / N), (a, b) => assertEq(typeof a, typeof b));
      cmp(`${t}: equals = (from vs push chain)`, () => deepEqual(vl, vl2), () => iIs(il, il2), perWalk * 4, both(true));
      cmp(`${t}: equals ≠ (one element differs), cold`, () => deepEqual(vl, vlDiff), () => iIs(il, ilDiff), perWalk * 4, both(false));
      iHash(il); iHash(ilDiff);
      cmp(`${t}: equals ≠, Immutable hashes warmed`, () => deepEqual(vl, vlDiff), () => iIs(il, ilDiff), perOp, both(false));
    }
    {
      const N = 10_000;
      const entries = Array.from({ length: N }, (_, i) => [`k${i}`, { id: i, label: `item-${i}`, tags: ['a', 'b'] }]);
      const fresh = () => entries.map(([k, v]) => [k, { ...v, tags: v.tags.slice() }]);
      const vm = ValueMap.from(entries), im = IMap(entries);
      cmp('Map 10k with record values: build from raw records', () => ValueMap.from(fresh()).size, () => IMap(fresh()).size, 20, assertEq);
      cmp('Map 10k with record values: build from canonical records', () => ValueMap.from(entries).size, () => IMap(entries).size, 20, assertEq);
      cmp('Map 10k with record values: set one raw record', (i) => vm.set('k1', { id: 1, label: 'item-1', tags: ['a', 'b'], v: i }).size, (i) => im.set('k1', { id: 1, label: 'item-1', tags: ['a', 'b'], v: i }).size, 50_000, assertEq);
    }
    return rows;
  },
};
