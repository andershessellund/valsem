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

  it('is itself a ReadonlySet — pass it where one is expected', () => {
    const takesReadonly = (rs: ReadonlySet<number>): number[] => [...rs.keys()].sort();
    const s = ValueSet.from([2, 1]);
    expect(takesReadonly(s)).toEqual([1, 2]);
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

  it('supports the set-algebra methods, returning fresh native Sets', () => {
    const a = ValueSet.from([1, 2, 3]);
    const b = ValueSet.from([2, 3, 4]);
    expect([...a.union(b)].sort()).toEqual([1, 2, 3, 4]);
    expect([...a.intersection(b)].sort()).toEqual([2, 3]);
    expect([...a.difference(b)]).toEqual([1]);
    expect([...a.symmetricDifference(b)].sort()).toEqual([1, 4]);
    expect(ValueSet.from([2, 3]).isSubsetOf(a)).toBe(true);
    expect(a.isSupersetOf(ValueSet.from([1]))).toBe(true);
    expect(a.isDisjointFrom(ValueSet.from([9]))).toBe(true);
    // The result is a plain Set — mutating it cannot touch the canonical value.
    const u = a.union(b);
    u.add(99);
    expect(a.size).toBe(3);
    expect(ValueSet.from([1, 2, 3])).toBe(a);
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
