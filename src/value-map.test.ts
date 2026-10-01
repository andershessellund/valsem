import { describe, expect, it } from 'vitest';
import { ValueMap } from './value-map.js';
import { hashCode, interned } from './deep-equal.js';
import { withPolluted } from './pollution.test-helpers.js';

describe('ValueMap', () => {
  it('empty maps are identical', () => {
    expect(ValueMap.empty<string, number>()).toBe(ValueMap.empty<string, number>());
    expect(ValueMap.from<string, number>([])).toBe(ValueMap.empty<string, number>());
  });

  it('equal maps are reference-identical (key-order independent)', () => {
    const a = ValueMap.fromObject({ a: 1, b: 2 });
    const b = ValueMap.fromObject({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('different maps are not identical', () => {
    expect(ValueMap.fromObject({ a: 1 })).not.toBe(ValueMap.fromObject({ a: 2 }));
    expect(ValueMap.fromObject({ a: 1 })).not.toBe(ValueMap.fromObject({ b: 1 }));
  });

  it('marks instances as [interned]', () => {
    expect(ValueMap.fromObject({ a: 1 })[interned]).toBe(true);
  });

  it('with: new key — incremental hash matches from-scratch', () => {
    const a = ValueMap.fromObject<number>({ x: 1 });
    const b = a.with('y', 2);
    expect(b).toBe(ValueMap.fromObject({ x: 1, y: 2 }));
    expect(b[hashCode]).toBe(ValueMap.fromObject({ x: 1, y: 2 })[hashCode]);
  });

  it('with: existing key, new value', () => {
    const a = ValueMap.fromObject<number>({ x: 1, y: 2 });
    const b = a.with('y', 99);
    expect(b).toBe(ValueMap.fromObject({ x: 1, y: 99 }));
  });

  it('with the same value returns this', () => {
    const a = ValueMap.fromObject<number>({ x: 1 });
    expect(a.with('x', 1)).toBe(a);
  });

  it('deleted: incremental hash matches from-scratch', () => {
    const a = ValueMap.fromObject<number>({ x: 1, y: 2, z: 3 });
    const b = a.deleted('y');
    expect(b).toBe(ValueMap.fromObject({ x: 1, z: 3 }));
  });

  it('deleted missing returns this', () => {
    const a = ValueMap.fromObject<number>({ x: 1 });
    expect(a.deleted('y')).toBe(a);
  });

  it('deleted to empty returns canonical empty', () => {
    const a = ValueMap.fromObject<number>({ x: 1 });
    expect(a.deleted('x')).toBe(ValueMap.empty<string, number>());
  });

  it('round-trip with/deleted produces same instance', () => {
    const a = ValueMap.fromObject<number>({ x: 1, y: 2 });
    expect(a.with('z', 3).deleted('z')).toBe(a);
  });

  it('iteration', () => {
    const a = ValueMap.fromObject<number>({ a: 1, b: 2 });
    // Order is content-determined but unspecified (seeded hashes) — sort.
    expect([...a.entries()].sort()).toEqual([['a', 1], ['b', 2]]);
    expect([...a.keys()].sort()).toEqual(['a', 'b']);
    expect([...a.values()].sort()).toEqual([1, 2]);
    expect(a.size).toBe(2);
    expect(a.get('a')).toBe(1);
    expect(a.has('a')).toBe(true);
  });

  it('iterates equal maps identically, whatever their construction order', () => {
    const a = ValueMap.fromObject<number>({ a: 1, b: 2, c: 3, d: 4 });
    const b = ValueMap.from<string, number>([['d', 4], ['c', 3], ['b', 2], ['a', 1]]);
    expect(b).toBe(a);
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it('hashes do not collide for swapped key/value', () => {
    const a = ValueMap.fromObject<number>({ a: 1, b: 2 });
    const b = ValueMap.fromObject<number>({ a: 2, b: 1 });
    expect(a).not.toBe(b);
    expect(a[hashCode]).not.toBe(b[hashCode]);
  });
});

describe('ValueMap — encapsulation & the ReadonlyMap contract', () => {
  it('does not expose its backing Map', () => {
    const m = ValueMap.fromObject({ a: 1 });
    expect((m as unknown as Record<string, unknown>)['map']).toBeUndefined();
  });

  it('is itself a ReadonlyMap — pass it where one is expected', () => {
    const takesReadonly = (rm: ReadonlyMap<string, number>): number[] =>
      [...rm.values()].sort((a, b) => a - b);
    const m = ValueMap.fromObject({ a: 2, b: 1 });
    expect(takesReadonly(m)).toEqual([1, 2]);
    const seen: [string, number][] = [];
    m.forEach((v, k, self) => {
      expect(self).toBe(m);
      seen.push([k, v]);
    });
    expect(seen.sort()).toEqual([['a', 2], ['b', 1]]);
  });

  it('yields a mutable copy via the iterator, leaving the value untouched', () => {
    const m = ValueMap.fromObject({ a: 1 });
    const copy = new Map(m);
    copy.set('b', 2);
    expect(copy.size).toBe(2);
    expect(m.size).toBe(1);
    expect(ValueMap.fromObject({ a: 1 })).toBe(m); // canonical instance intact
  });
});

describe('ValueMap — undefined IS a value here, unlike in records', () => {
  it('stores undefined distinctly from absence', () => {
    const base = ValueMap.fromObject<number | undefined>({ a: 1 });
    const withU = base.with('b', undefined);
    expect(withU.size).toBe(2);
    expect(withU.has('b')).toBe(true);
    expect(withU).not.toBe(base);
    expect(withU.deleted('b')).toBe(base); // removing it restores the canonical base
  });

  it('two maps differing only by a stored undefined are distinct values', () => {
    const a = ValueMap.from<string, number | undefined>([['k', undefined]]);
    expect(a.size).toBe(1);
    expect(a).not.toBe(ValueMap.empty());
  });

  it('fromObject applies record semantics to its record input', () => {
    const m = ValueMap.fromObject({ a: 1, b: undefined as unknown as number });
    expect(m.size).toBe(1);
    expect(m.has('b')).toBe(false);
    expect(m).toBe(ValueMap.fromObject({ a: 1 }));
  });
});

describe('ValueMap.fromObject — own keys only', () => {
  it('does not admit inherited enumerable keys (prototype pollution) as entries', () => {
    withPolluted(Object.prototype, 'polluted', 7, () => {
      const m = ValueMap.fromObject({ a: 1 });
      expect(m.size).toBe(1);
      expect([...m.keys()]).toEqual(['a']);
      expect(m.has('polluted')).toBe(false);
    });
  });
});

describe('ValueMap — size comes from the root', () => {
  it('agrees with a walk after every kind of update', () => {
    let m = ValueMap.empty<number, number>();
    for (let i = 0; i < 300; i++) m = m.with(i, i);
    expect(m.size).toBe(300);
    m = m.with(5, 99); // update, not growth
    expect(m.size).toBe(300);
    for (let i = 0; i < 150; i++) m = m.deleted(i * 2);
    expect(m.size).toBe(150);
    expect([...m].length).toBe(150);
    expect(ValueMap.from([...m]).size).toBe(150);
    expect(ValueMap.fromObject({ a: 1, b: undefined, c: 3 }).size).toBe(2);
  });
});

describe('ValueMap.from reads entries as new Map does', () => {
  it('by their 0 and 1: an array-like is an entry, a string is not', () => {
    expect(ValueMap.from([{ 0: 'k', 1: 'v' } as unknown as [string, string]]).get('k')).toBe('v');
    expect(() => ValueMap.from(['ab'] as unknown as [string, string][])).toThrow(/is not an entry object/);
  });
});
