// ---------------------------------------------------------------------------
// OrderedSet — the insertion-ordered persistent set. Same anchors as
// OrderedMap (property-ordered.test.ts drives the random sequences).
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { OrderedSet } from './ordered-set.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { intern } from './intern.js';
import { deepEqual, hashCode, interned } from './deep-equal.js';
import { HashSet } from './hash-set.js';


/** The index at which each run (leaf, then the open tail) of `list` starts — where an inserted key becomes an anchor. */
function runStarts(list: ValueList<unknown>): number[] {
  const { tree, tail } = list._structure();
  const starts: number[] = [];
  let pos = 0;
  const walk = (node: unknown[]): void => {
    if (node.length !== 0 && Array.isArray(node[0])) for (const kid of node) walk(kid as unknown[]);
    else {
      starts.push(pos);
      pos += node.length;
    }
  };
  if (tree !== null) walk(tree as unknown[]);
  if (tail.length !== 0) starts.push(pos);
  return starts;
}

describe('OrderedSet', () => {
  it('empty sets are one instance; equal member sequences are one object however built', () => {
    expect(OrderedSet.empty()).toBe(OrderedSet.empty());
    expect(OrderedSet.from([])).toBe(OrderedSet.empty());
    const s = OrderedSet.of('a', 'b', 'c');
    expect(OrderedSet.empty<string>().add('a').add('b').add('c')).toBe(s);
    expect(s.add('d').delete('d')).toBe(s);
    expect(OrderedSet.from(['a', 'b', 'c', 'a', 'b'])).toBe(s);
  });

  it('order is part of the value — unlike ValueSet', () => {
    const ab = OrderedSet.of(1, 2);
    const ba = OrderedSet.of(2, 1);
    expect(ab).not.toBe(ba);
    expect(deepEqual(ab, ba)).toBe(false);
    expect(ValueSet.from(ab)).toBe(ValueSet.from(ba));
  });

  it('is a value: [interned], hashed, pooled, a HashSet member, frozen', () => {
    const s = OrderedSet.of(1, 2);
    expect(s[interned]).toBe(true);
    expect(intern(s)).toBe(s);
    expect(typeof s[hashCode]).toBe('number');
    expect(new HashSet().add(s).has(OrderedSet.of(1, 2))).toBe(true);
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.valueList).toBe(ValueList.of(1, 2));
  });

  it('reads: has, indexOf, at, first, last, size', () => {
    const s = OrderedSet.of('a', 'b', 'c');
    expect(s.size).toBe(3);
    expect(s.has('b')).toBe(true);
    expect(s.has('z')).toBe(false);
    expect(s.indexOf('c')).toBe(2);
    expect(s.indexOf('z')).toBe(-1);
    expect(s.at(1)).toBe('b');
    expect(s.at(5)).toBeUndefined();
    expect(s.first()).toBe('a');
    expect(s.last()).toBe('c');
    expect(OrderedSet.empty().last()).toBeUndefined();
  });

  it('probes are canonicalized: structurally equal raw members match', () => {
    const s = OrderedSet.from([{ x: 1 }, { x: 2 }]);
    expect(s.has({ x: 2 })).toBe(true);
    expect(s.indexOf({ x: 2 })).toBe(1);
    expect(s.add({ x: 1 })).toBe(s);
    expect(s.delete({ x: 1 })).toBe(OrderedSet.from([{ x: 2 }]));
  });

  it('add appends (a present member stays put); delete then add moves to the end', () => {
    const s = OrderedSet.of('a', 'b', 'c');
    expect([...s.add('d')]).toEqual(['a', 'b', 'c', 'd']);
    expect(s.add('a')).toBe(s);
    expect([...s.delete('a').add('a')]).toEqual(['b', 'c', 'a']);
    expect(s.delete('z')).toBe(s);
    expect(s.delete('a').delete('b').delete('c')).toBe(OrderedSet.empty());
  });

  it('insertAt places a new member; a present member or a bad index throws', () => {
    const s = OrderedSet.of('a', 'b', 'c');
    expect([...s.insertAt(0, 'z')]).toEqual(['z', 'a', 'b', 'c']);
    expect([...s.insertAt(2, 'z')]).toEqual(['a', 'b', 'z', 'c']);
    expect(s.insertAt(3, 'z')).toBe(s.add('z'));
    expect(() => s.insertAt(0, 'b')).toThrow(/already a member/);
    expect(() => s.insertAt(4, 'z')).toThrow(RangeError);
  });

  it('iterates in order: values, keys, entries, forEach, spread, new Set; helpers apply', () => {
    const s = OrderedSet.of(3, 1, 2);
    expect([...s]).toEqual([3, 1, 2]);
    expect([...s.keys()]).toEqual([3, 1, 2]);
    expect([...s.entries()]).toEqual([
      [3, 3],
      [1, 1],
      [2, 2],
    ]);
    const seen: number[] = [];
    s.forEach((v, v2, set) => {
      expect(v2).toBe(v);
      expect(set).toBe(s);
      seen.push(v);
    });
    expect(seen).toEqual([3, 1, 2]);
    expect([...new Set(s)]).toEqual([3, 1, 2]);
    expect(s.values().map((x) => x * 2).toArray()).toEqual([6, 2, 4]);
  });

  it('NaN is one member; -0 is stored as +0', () => {
    const s = OrderedSet.of(NaN, 1, NaN, -0);
    expect(s.size).toBe(3);
    expect(s.indexOf(NaN)).toBe(0);
    expect(Object.is(s.at(2), 0)).toBe(true);
    expect(s.has(0)).toBe(true);
  });

  it('undefined is a legitimate member, wherever it sits', () => {
    const N = 300;
    const base = Array.from({ length: N }, (_, i) => `m${i}`);
    const starts = runStarts(OrderedSet.from(base).valueList);
    expect(starts.length).toBeGreaterThan(2);
    for (const at of [...starts, 5, N]) {
      const members: unknown[] = base.slice();
      members.splice(at, 0, undefined);
      const s = OrderedSet.from(members);
      expect(s.size).toBe(N + 1);
      expect(s.indexOf(undefined)).toBe(at);
      for (let i = 0; i < members.length; i += 5) expect(s.indexOf(members[i])).toBe(i);
      expect(OrderedSet.from(base).insertAt(at, undefined as unknown as string)).toBe(s);
      const other = members[at === N ? 0 : at + 1] as string;
      expect(s.delete(other).indexOf(undefined)).toBe(at === N ? at - 1 : at);
    }
  });

  it('entries() is a plain iterator object: no iterator-helper dependency', () => {
    const s = OrderedSet.of(1, 2);
    const it = s.entries();
    expect(typeof it.next).toBe('function');
    expect(it.next()).toEqual({ value: [1, 1], done: false });
    expect(it.next()).toEqual({ value: [2, 2], done: false });
    expect(it.next().done).toBe(true);
  });

  it('every member finds its position at 3,000 members, through deletes and inserts', () => {
    const N = 3000;
    const model = Array.from({ length: N }, (_, i) => `m${i}`);
    let s = OrderedSet.from(model);
    for (const i of [0, 1, 700, 1500, 2999, 2997]) {
      s = s.delete(model[i]!);
      model.splice(i, 1);
    }
    for (const [i, v] of [
      [0, 'n0'],
      [1234, 'n1'],
      [model.length, 'n2'],
    ] as [number, string][]) {
      s = s.insertAt(i, v);
      model.splice(i, 0, v);
    }
    expect([...s]).toEqual(model);
    for (let i = 0; i < model.length; i += 5) expect(s.indexOf(model[i]!)).toBe(i);
    expect(s).toBe(OrderedSet.from(model));
  });
});
