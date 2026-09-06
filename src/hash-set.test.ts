import { describe, it, expect } from 'vitest';
import { HashSet, type HashSetOptions } from './hash-set.js';
import { HashMap } from './hash-map.js';
import { intern, isCanonical } from './intern.js';
import { ValueList } from './value-list.js';

describe.each<[string, HashSetOptions]>([
  ['default (interning)', {}],
  ['{ intern: false }', { intern: false }],
])('HashSet — %s', (_name, options) => {
  const interning = options.intern !== false;

  it('membership is by content, key order included', () => {
    const s = new HashSet<{ x: number; y: number }>(options);
    s.add({ x: 1, y: 2 });
    expect(s.has({ y: 2, x: 1 })).toBe(true);
    expect(s.has({ x: 1, y: 3 })).toBe(false);
    s.add({ y: 2, x: 1 }); // same member
    expect(s.size).toBe(1);
    expect(s.delete({ x: 1, y: 2 })).toBe(true);
    expect(s.delete({ x: 1, y: 2 })).toBe(false);
    expect(s.size).toBe(0);
  });

  it('primitives, symbols, canonical values, and nested structures', () => {
    const s = new HashSet<unknown>(options);
    const sym = Symbol('s');
    s.add(1).add('a').add(sym).add(intern({ a: [1, { b: 2 }] })).add(ValueList.of(1, 2)).add(NaN);
    expect(s.has(1)).toBe(true);
    expect(s.has(sym)).toBe(true);
    expect(s.has({ a: [1, { b: 2 }] })).toBe(true); // raw spelling of the canonical member
    expect(s.has(ValueList.of(1, 2))).toBe(true);
    expect(s.has(NaN)).toBe(true);
    expect(s.size).toBe(6);
  });

  it('iterates in insertion order, and the first stored member is kept on re-add', () => {
    const s = new HashSet<{ id: number }>(options);
    const first = { id: 1 };
    s.add(first).add({ id: 2 }).add({ id: 1 });
    expect([...s].map((v) => v.id)).toEqual([1, 2]);
    expect([...s.keys()]).toEqual([...s.values()]);
    expect([...s.entries()]).toEqual([...s].map((v) => [v, v]));
    const seen: number[] = [];
    s.forEach((v, v2, set) => {
      expect(v2).toBe(v);
      expect(set).toBe(s);
      seen.push(v.id);
    });
    expect(seen).toEqual([1, 2]);
    const [stored] = [...s];
    if (interning) {
      expect(stored).toBe(intern({ id: 1 })); // the canonical, not the caller's object
      expect(isCanonical(stored)).toBe(true);
    } else {
      expect(stored).toBe(first); // the caller's object, as given
      expect(isCanonical(first)).toBe(false);
      expect(Object.isFrozen(first)).toBe(false);
    }
    s.clear();
    expect(s.size).toBe(0);
    expect([...s]).toEqual([]);
  });

  it('from(iterable), hasCanonical, and non-value rejection', () => {
    const s = HashSet.from([{ k: 1 }, { k: 2 }, { k: 1 }], options);
    expect(s.size).toBe(2);
    expect(s.hasCanonical(intern({ k: 1 }))).toBe(true);
    expect(s.hasCanonical(intern({ k: 9 }))).toBe(false);
    expect(() => s.hasCanonical({ k: 1 })).toThrow(/takes a canonical element/);
    expect(() => s.add(new Date() as never)).toThrow();
  });

  it('is correct across many members (collisions included)', () => {
    const s = new HashSet<{ i: number; s: string }>(options);
    for (let i = 0; i < 3000; i++) s.add({ i, s: `k${i}` });
    expect(s.size).toBe(3000);
    for (let i = 0; i < 3000; i++) expect(s.has({ s: `k${i}`, i })).toBe(true);
    for (let i = 0; i < 3000; i += 2) expect(s.delete({ i, s: `k${i}` })).toBe(true);
    expect(s.size).toBe(1500);
    for (let i = 1; i < 3000; i += 2) expect(s.has({ i, s: `k${i}` })).toBe(true);
  });
});

describe('HashMap.from', () => {
  it('builds from entries in either mode', () => {
    const m = HashMap.from([[{ a: 1 }, 'x'], [{ a: 1 }, 'y']]);
    expect(m.size).toBe(1);
    expect(m.get({ a: 1 })).toBe('y');
    const n = HashMap.from([[{ a: 1 }, 'x']], { intern: false });
    expect(n.get({ a: 1 })).toBe('x');
    expect(isCanonical([...n.keys()][0])).toBe(false);
  });
});
