// Hash-consing canonicality of the CHAMP-backed ValueMap/ValueSet.
//
// The load-bearing property: the backing tree shape is a pure function of the
// CONTENT — never of construction history — so equal content converges on the
// same root node, the same canonical wrapper, and `===`. These tests build
// the same content along many different histories (shuffled orders,
// insert/delete detours) and assert instance identity. Hashes are seeded per
// process, so every CI run fuzzes a different tree shape for free.
import { describe, it, expect } from 'vitest';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { deepEqual } from './deep-equal.js';
import { intern } from './intern.js';

/** Deterministic shuffle (LCG) — variation comes from the seeded hashes. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const a = items.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

describe('ValueMap — hash-consed canonicality', () => {
  it('converges across insertion orders (300 keys, several shuffles)', () => {
    const entries: [string, number][] = [];
    for (let i = 0; i < 300; i++) entries.push([`key-${i}`, i]);
    const base = ValueMap.from(entries);
    for (let s = 1; s <= 4; s++) {
      expect(ValueMap.from(shuffled(entries, s))).toBe(base);
    }
    expect(base.size).toBe(300);
  });

  it('insert/delete detours land back on the same instance', () => {
    const base = ValueMap.from<string, number>([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(base.set('zz', 9).delete('zz')).toBe(base);
    expect(base.delete('a').set('a', 1)).toBe(base);
    expect(base.set('a', 99).set('a', 1)).toBe(base);
  });

  it('a random op-walk agrees with a native-Map mirror, instance-exactly', () => {
    let m = ValueMap.empty<number, number>();
    const mirror = new Map<number, number>();
    let s = 0xbeef;
    for (let i = 0; i < 2000; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const key = s % 200;
      if (s & 0x10000) {
        m = m.set(key, i);
        mirror.set(key, i);
      } else {
        m = m.delete(key);
        mirror.delete(key);
      }
    }
    expect(m.size).toBe(mirror.size);
    for (const [k, v] of mirror) {
      expect(m.get(k)).toBe(v);
    }
    // Lineage-free convergence: a fresh build of the surviving content is
    // the SAME instance as the one reached through 2000 ops.
    expect(ValueMap.from(mirror)).toBe(m);
  });

  it('deletion unwinds to the canonical empty map', () => {
    let m = ValueMap.from<string, number>([
      ['x', 1],
      ['y', 2],
    ]);
    m = m.delete('x').delete('y');
    expect(m).toBe(ValueMap.empty());
    expect(m.size).toBe(0);
  });

  it('deep equality between equal maps is instance identity', () => {
    const a = ValueMap.fromObject({ p: 1, q: 2 });
    const b = ValueMap.from<string, number>([
      ['q', 2],
      ['p', 1],
    ]);
    expect(a).toBe(b);
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(a, ValueMap.fromObject({ p: 1, q: 3 }))).toBe(false);
  });

  it('NaN keys and stored undefined behave like native Map', () => {
    const m = ValueMap.empty<number, string | undefined>().set(NaN, 'nan').set(1, undefined);
    expect(m.has(NaN)).toBe(true);
    expect(m.get(NaN)).toBe('nan');
    expect(m.has(1)).toBe(true); // stored undefined is present …
    expect(m.get(1)).toBeUndefined();
    expect(m.has(2)).toBe(false); // … and distinct from absence
    expect(m.delete(NaN).has(NaN)).toBe(false);
    // +0 and -0 are the same key (SameValueZero).
    expect(ValueMap.empty<number, number>().set(-0, 1)).toBe(
      ValueMap.empty<number, number>().set(0, 1),
    );
  });

  it('NaN stored as a value does not split canonical instances', () => {
    const a = ValueMap.empty<string, number>().set('x', NaN);
    const b = ValueMap.empty<string, number>().set('x', NaN);
    expect(a).toBe(b);
    expect(a.set('x', NaN)).toBe(a); // unchanged write is `this`
  });

  it('a derived map allocates only a spine of new nodes', () => {
    const entries: [string, number][] = [];
    for (let i = 0; i < 128; i++) entries.push([`k${i}`, i]);
    const base = ValueMap.from(entries);
    const before = ValueMap._nodeStats().bnodes;
    const derived = base.set('one-more', 1);
    const after = ValueMap._nodeStats().bnodes;
    expect(derived).not.toBe(base);
    expect(after - before).toBeLessThanOrEqual(8); // ≤ path-copied spine
  });

  it('interned object keys work across lineages', () => {
    const k1 = intern({ id: 7 });
    const k2 = intern({ id: 7 });
    expect(k1).toBe(k2);
    const a = ValueMap.empty<object, string>().set(k1, 'v');
    const b = ValueMap.empty<object, string>().set(k2, 'v');
    expect(a).toBe(b);
    expect(a.get(k2)).toBe('v');
  });
});

describe('ValueSet — hash-consed canonicality', () => {
  it('converges across insertion orders', () => {
    const members: (number | string)[] = [];
    for (let i = 0; i < 300; i++) members.push(i % 2 ? i : `m${i}`);
    const base = ValueSet.from(members);
    for (let s = 1; s <= 4; s++) {
      expect(ValueSet.from(shuffled(members, s))).toBe(base);
    }
    expect(base.size).toBe(300);
  });

  it('add/delete detours land back on the same instance', () => {
    const base = ValueSet.from([1, 2, 3]);
    expect(base.add(99).delete(99)).toBe(base);
    expect(base.delete(1).add(1)).toBe(base);
    expect(base.add(2)).toBe(base);
  });

  it('a random op-walk agrees with a native-Set mirror, instance-exactly', () => {
    let v = ValueSet.empty<number>();
    const mirror = new Set<number>();
    let s = 0xcafe;
    for (let i = 0; i < 2000; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const member = s % 200;
      if (s & 0x10000) {
        v = v.add(member);
        mirror.add(member);
      } else {
        v = v.delete(member);
        mirror.delete(member);
      }
    }
    expect(v.size).toBe(mirror.size);
    for (const m of mirror) expect(v.has(m)).toBe(true);
    expect(ValueSet.from(mirror)).toBe(v);
  });

  it('deletion unwinds to the canonical empty set', () => {
    expect(ValueSet.from([7]).delete(7)).toBe(ValueSet.empty());
  });

  it('equal sets iterate identically', () => {
    const a = ValueSet.from([5, 1, 4, 2, 3]);
    const b = ValueSet.from([1, 2, 3, 4, 5]);
    expect(b).toBe(a);
    expect([...b]).toEqual([...a]);
  });
});
