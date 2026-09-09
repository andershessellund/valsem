import { describe, expect, it } from 'vitest';
import { ValueSet } from './value-set.js';
import { equals, interned } from './deep-equal.js';

describe('ValueSet', () => {
  it('empty sets are identical', () => {
    expect(ValueSet.empty<number>()).toBe(ValueSet.empty<number>());
    expect(ValueSet.from<number>([])).toBe(ValueSet.empty<number>());
  });

  it('equal sets are reference-identical (order-independent)', () => {
    expect(ValueSet.from([1, 2, 3])).toBe(ValueSet.from([3, 2, 1]));
  });

  it('marks instances as [interned]', () => {
    expect(ValueSet.from([1])[interned]).toBe(true);
  });

  it('add: new value', () => {
    const a = ValueSet.from([1, 2]);
    const b = a.add(3);
    expect(b).toBe(ValueSet.from([1, 2, 3]));
  });

  it('add: existing value returns this', () => {
    const a = ValueSet.from([1, 2]);
    expect(a.add(1)).toBe(a);
  });

  it('delete: existing value', () => {
    const a = ValueSet.from([1, 2, 3]);
    const b = a.delete(2);
    expect(b).toBe(ValueSet.from([1, 3]));
  });

  it('delete: missing value returns this', () => {
    const a = ValueSet.from([1, 2]);
    expect(a.delete(99)).toBe(a);
  });

  it('delete to empty returns canonical empty', () => {
    expect(ValueSet.from([1]).delete(1)).toBe(ValueSet.empty<number>());
  });

  it('round-trip add/delete', () => {
    const a = ValueSet.from([1, 2]);
    expect(a.add(3).delete(3)).toBe(a);
  });

  it('iteration', () => {
    const a = ValueSet.from([1, 2, 3]);
    expect([...a].sort()).toEqual([1, 2, 3]);
    expect(a.size).toBe(3);
    expect(a.has(2)).toBe(true);
  });
});

describe('ValueSet — encapsulation & the ReadonlySet contract', () => {
  it('does not expose its backing Set', () => {
    const s = ValueSet.from([1, 2]);
    expect((s as unknown as Record<string, unknown>)['set']).toBeUndefined();
  });

  it('has the ReadonlySet read surface, and is a ReadonlySetLike the native methods accept', () => {
    type Reads = Pick<
      ReadonlySet<number>,
      'size' | 'has' | 'keys' | 'values' | 'entries' | typeof Symbol.iterator
    >;
    const takesReads = (rs: Reads): number[] => [...rs.keys()].sort();
    const s = ValueSet.from([2, 1]);
    expect(takesReads(s)).toEqual([1, 2]);
    const like: ReadonlySetLike<number> = s;
    expect([...new Set([2, 3]).union(like)].sort()).toEqual([1, 2, 3]);
    expect(new Set([1]).isSubsetOf(s)).toBe(true);
    expect(new Set([9]).isDisjointFrom(s)).toBe(true);
    // NB: no order assertion — canonical instances keep the insertion order of
    // whichever structurally-equal set was pooled first.
    expect([...s.entries()].sort()).toEqual([[1, 1], [2, 2]]);
    const seen: number[] = [];
    s.forEach((v, v2, self) => {
      expect(v).toBe(v2);
      expect(self).toBe(s);
      seen.push(v);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('supports the set-algebra methods, returning canonical ValueSets', () => {
    const a = ValueSet.from([1, 2, 3]);
    const b = ValueSet.from([2, 3, 4]);
    // The results are ValueSets — canonical, so equality is `toBe`.
    expect(a.union(b)).toBe(ValueSet.from([1, 2, 3, 4]));
    expect(a.intersection(b)).toBe(ValueSet.from([2, 3]));
    expect(a.difference(b)).toBe(ValueSet.from([1]));
    expect(a.symmetricDifference(b)).toBe(ValueSet.from([1, 4]));
    expect(ValueSet.from([2, 3]).isSubsetOf(a)).toBe(true);
    expect(ValueSet.from([2, 5]).isSubsetOf(a)).toBe(false);
    expect(a.isSupersetOf(ValueSet.from([1]))).toBe(true);
    expect(a.isSupersetOf(ValueSet.from([1, 9]))).toBe(false);
    expect(a.isDisjointFrom(ValueSet.from([9]))).toBe(true);
    expect(a.isDisjointFrom(b)).toBe(false);
    // Identities fall out of canonicality.
    expect(a.union(ValueSet.empty())).toBe(a);
    expect(a.union(a)).toBe(a);
    expect(a.intersection(a)).toBe(a);
    expect(a.difference(ValueSet.empty())).toBe(a);
    expect(a.difference(a)).toBe(ValueSet.empty());
    expect(a.symmetricDifference(a)).toBe(ValueSet.empty());
    expect(a.symmetricDifference(ValueSet.empty())).toBe(a);
    // The operands are untouched.
    expect(a.size).toBe(3);
    expect(ValueSet.from([1, 2, 3])).toBe(a);
  });

  it('set algebra takes any iterable of values, interned on entry — membership is by this set\'s equality', () => {
    const a = ValueSet.from([{ x: 1 }]);
    // Raw spellings from a native Set, an array, or a generator converge on the canonical member.
    expect(a.union(new Set([{ x: 1 }, { x: 2 }]))).toBe(ValueSet.from([{ x: 1 }, { x: 2 }]));
    expect(a.union([{ x: 1 }, { x: 2 }])).toBe(ValueSet.from([{ x: 1 }, { x: 2 }]));
    expect(a.union((function* () { yield { x: 2 }; })())).toBe(ValueSet.from([{ x: 1 }, { x: 2 }]));
    // Two raw spellings of one value are one member: they toggle once, not twice.
    expect(a.symmetricDifference([{ x: 1 }, { x: 1 }])).toBe(ValueSet.empty());
    expect(a.symmetricDifference([{ x: 2 }, { x: 2 }])).toBe(ValueSet.from([{ x: 1 }, { x: 2 }]));
    // The argument's own `has` is never consulted, so the answer does not
    // depend on which operand is larger — a native Set of raw objects is
    // matched by value in every direction.
    expect(ValueSet.from([{ x: 1 }]).intersection(new Set([{ x: 1 }, { x: 2 }, { x: 3 }]))).toBe(
      ValueSet.from([{ x: 1 }]),
    );
    expect(ValueSet.from([{ x: 1 }, { x: 2 }, { x: 3 }]).intersection(new Set([{ x: 1 }]))).toBe(
      ValueSet.from([{ x: 1 }]),
    );
    expect(ValueSet.from([{ x: 1 }, { x: 2 }]).difference(new Set([{ x: 2 }, { x: 3 }, { x: 4 }]))).toBe(
      ValueSet.from([{ x: 1 }]),
    );
    expect(ValueSet.from([{ x: 1 }]).isSubsetOf(new Set([{ x: 1 }]))).toBe(true);
    expect(ValueSet.from([{ x: 1 }]).isSubsetOf([{ x: 1 }, { x: 2 }])).toBe(true);
    expect(ValueSet.from([{ x: 1 }, { x: 2 }]).isSupersetOf(new Set([{ x: 1 }]))).toBe(true);
    expect(ValueSet.from([{ x: 1 }]).isDisjointFrom([{ x: 1 }])).toBe(false);
    // Non-values in the argument are rejected as everywhere.
    expect(() => a.union([new Date()])).toThrow(/ValueDate/);
  });

  it('a set knows its size from its root, at every scale', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const s = ValueSet.from(xs);
    expect(s.size).toBe(1000);
    expect([...s].length).toBe(1000);
    expect(s.delete(3).size).toBe(999);
    expect(s.union([1000, 1001]).size).toBe(1002);
    expect(s.intersection(ValueSet.from([5, 6, 7, 2000])).size).toBe(3);
  });

  it('set algebra matches the native Set on primitives, in both size orders', () => {
    const cases: [number[], number[]][] = [
      [[1, 2, 3], [2, 3, 4]],
      [[1], [1, 2, 3, 4, 5]],
      [[1, 2, 3, 4, 5], [5, 6]],
      [[], [1]],
      [[1], []],
      [[1, 2], [3, 4]],
      [[1, 2], [1, 2]],
    ];
    const sorted = (s: Iterable<number>): number[] => [...s].sort((x, y) => x - y);
    for (const [xs, ys] of cases) {
      const v = ValueSet.from(xs);
      const w = ValueSet.from(ys);
      const n = new Set(xs);
      const m = new Set(ys);
      expect(sorted(v.union(w))).toEqual(sorted(n.union(m)));
      expect(sorted(v.intersection(w))).toEqual(sorted(n.intersection(m)));
      expect(sorted(v.difference(w))).toEqual(sorted(n.difference(m)));
      expect(sorted(v.symmetricDifference(w))).toEqual(sorted(n.symmetricDifference(m)));
      expect(v.isSubsetOf(w)).toBe(n.isSubsetOf(m));
      expect(v.isSupersetOf(w)).toBe(n.isSupersetOf(m));
      expect(v.isDisjointFrom(w)).toBe(n.isDisjointFrom(m));
      // …and against the native Set as `other`.
      expect(sorted(v.union(m))).toEqual(sorted(n.union(m)));
      expect(sorted(v.intersection(m))).toEqual(sorted(n.intersection(m)));
      expect(sorted(v.difference(m))).toEqual(sorted(n.difference(m)));
      expect(sorted(v.symmetricDifference(m))).toEqual(sorted(n.symmetricDifference(m)));
      expect(v.isSubsetOf(m)).toBe(n.isSubsetOf(m));
      expect(v.isSupersetOf(m)).toBe(n.isSupersetOf(m));
      expect(v.isDisjointFrom(m)).toBe(n.isDisjointFrom(m));
    }
  });

  it('yields a mutable copy via the iterator', () => {
    const s = ValueSet.from([1]);
    const copy = new Set(s);
    copy.add(2);
    expect(copy.size).toBe(2);
    expect(s.size).toBe(1);
  });
});

describe('ValueSet — [equals]', () => {
  it('is root identity for ValueSets and false for anything else', () => {
    const a = ValueSet.from([1, 2]);
    expect(a[equals](ValueSet.from([2, 1]))).toBe(true);
    expect(a[equals](ValueSet.from([1, 2, 3]))).toBe(false);
    expect(a[equals](new Set([1, 2]))).toBe(false);
    expect(a[equals]([1, 2])).toBe(false);
    expect(a[equals](null)).toBe(false);
  });
});
