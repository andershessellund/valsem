import { describe, expect, it } from 'vitest';
import { InternMap } from './intern-map.js';
import { hashCode, interned } from './deep-equal.js';

describe('InternMap', () => {
  it('empty maps are identical', () => {
    expect(InternMap.empty<string, number>()).toBe(InternMap.empty<string, number>());
    expect(InternMap.from<string, number>([])).toBe(InternMap.empty<string, number>());
  });

  it('equal maps are reference-identical (key-order independent)', () => {
    const a = InternMap.fromObject({ a: 1, b: 2 });
    const b = InternMap.fromObject({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('different maps are not identical', () => {
    expect(InternMap.fromObject({ a: 1 })).not.toBe(InternMap.fromObject({ a: 2 }));
    expect(InternMap.fromObject({ a: 1 })).not.toBe(InternMap.fromObject({ b: 1 }));
  });

  it('marks instances as [interned]', () => {
    expect(InternMap.fromObject({ a: 1 })[interned]).toBe(true);
  });

  it('set: new key — incremental hash matches from-scratch', () => {
    const a = InternMap.fromObject<number>({ x: 1 });
    const b = a.set('y', 2);
    expect(b).toBe(InternMap.fromObject({ x: 1, y: 2 }));
    expect(b[hashCode]).toBe(InternMap.fromObject({ x: 1, y: 2 })[hashCode]);
  });

  it('set: existing key with new value', () => {
    const a = InternMap.fromObject<number>({ x: 1, y: 2 });
    const b = a.set('y', 99);
    expect(b).toBe(InternMap.fromObject({ x: 1, y: 99 }));
  });

  it('set with same value returns this', () => {
    const a = InternMap.fromObject<number>({ x: 1 });
    expect(a.set('x', 1)).toBe(a);
  });

  it('delete: incremental hash matches from-scratch', () => {
    const a = InternMap.fromObject<number>({ x: 1, y: 2, z: 3 });
    const b = a.delete('y');
    expect(b).toBe(InternMap.fromObject({ x: 1, z: 3 }));
  });

  it('delete missing returns this', () => {
    const a = InternMap.fromObject<number>({ x: 1 });
    expect(a.delete('y')).toBe(a);
  });

  it('delete to empty returns canonical empty', () => {
    const a = InternMap.fromObject<number>({ x: 1 });
    expect(a.delete('x')).toBe(InternMap.empty<string, number>());
  });

  it('round-trip set/delete produces same instance', () => {
    const a = InternMap.fromObject<number>({ x: 1, y: 2 });
    expect(a.set('z', 3).delete('z')).toBe(a);
  });

  it('iteration', () => {
    const a = InternMap.fromObject<number>({ a: 1, b: 2 });
    expect([...a.entries()]).toEqual([['a', 1], ['b', 2]]);
    expect([...a.keys()]).toEqual(['a', 'b']);
    expect([...a.values()]).toEqual([1, 2]);
    expect(a.size).toBe(2);
    expect(a.get('a')).toBe(1);
    expect(a.has('a')).toBe(true);
  });

  it('hashes do not collide for swapped key/value', () => {
    const a = InternMap.fromObject<number>({ a: 1, b: 2 });
    const b = InternMap.fromObject<number>({ a: 2, b: 1 });
    expect(a).not.toBe(b);
    expect(a[hashCode]).not.toBe(b[hashCode]);
  });
});

describe('InternMap — encapsulation & the ReadonlyMap contract', () => {
  it('does not expose its backing Map', () => {
    const m = InternMap.fromObject({ a: 1 });
    expect((m as unknown as Record<string, unknown>)['map']).toBeUndefined();
  });

  it('is itself a ReadonlyMap — pass it where one is expected', () => {
    const takesReadonly = (rm: ReadonlyMap<string, number>): number[] =>
      [...rm.values()].sort((a, b) => a - b);
    const m = InternMap.fromObject({ a: 2, b: 1 });
    expect(takesReadonly(m)).toEqual([1, 2]);
    const seen: [string, number][] = [];
    m.forEach((v, k, self) => {
      expect(self).toBe(m);
      seen.push([k, v]);
    });
    expect(seen).toEqual([['a', 2], ['b', 1]]);
  });

  it('yields a mutable copy via the iterator, leaving the value untouched', () => {
    const m = InternMap.fromObject({ a: 1 });
    const copy = new Map(m);
    copy.set('b', 2);
    expect(copy.size).toBe(2);
    expect(m.size).toBe(1);
    expect(InternMap.fromObject({ a: 1 })).toBe(m); // canonical instance intact
  });
});

describe('InternMap — undefined IS a value here, unlike in records', () => {
  it('stores undefined distinctly from absence', () => {
    const base = InternMap.fromObject({ a: 1 });
    const withU = base.set('b', undefined);
    expect(withU.size).toBe(2);
    expect(withU.has('b')).toBe(true);
    expect(withU).not.toBe(base);
    expect(withU.delete('b')).toBe(base); // removing it restores the canonical base
  });

  it('two maps differing only by a stored undefined are distinct values', () => {
    const a = InternMap.from<string, number | undefined>([['k', undefined]]);
    expect(a.size).toBe(1);
    expect(a).not.toBe(InternMap.empty());
  });

  it('fromObject applies record semantics to its record input', () => {
    const m = InternMap.fromObject({ a: 1, b: undefined as unknown as number });
    expect(m.size).toBe(1);
    expect(m.has('b')).toBe(false);
    expect(m).toBe(InternMap.fromObject({ a: 1 }));
  });
});
