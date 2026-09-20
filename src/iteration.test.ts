// Iteration protocol of the collections: explicit-stack iterator objects
// (not generators), so the protocol details are pinned here — done-state,
// fresh iterators per call, iterator helpers where the runtime has them,
// forEach signatures, and the structural boundaries (trie levels, tree/tail,
// multi-level tree) that the stacks must cross correctly.
//
// The protocol is a law of every collection, so it runs over the roster,
// on every iterator each one hands out. What is particular to one type's
// structure (which boundaries its stack crosses) follows, type by type.
import { describe, it, expect } from 'vitest';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { COLLECTIONS } from './roster.test-helpers.js';

const hasIteratorHelpers = typeof (globalThis as { Iterator?: unknown }).Iterator === 'function';

describe.each(COLLECTIONS.map((c) => [c.name, c] as const))('iterator protocol — %s', (_name, c) => {
  it('every iterator is its own iterable, reports done once, and stays done', () => {
    for (const [which, it] of c.iterators(c.of('a'))) {
      expect(it[Symbol.iterator](), which).toBe(it);
      expect(it.next().done, which).toBe(false);
      expect(it.next(), which).toEqual({ value: undefined, done: true });
      expect(it.next(), which).toEqual({ value: undefined, done: true });
    }
  });

  it('each call returns a fresh, independent iterator', () => {
    const value = c.of('a', 'b');
    const first = c.iterators(value);
    const second = c.iterators(value);
    first.forEach(([which, x], i) => {
      const y = second[i]![1];
      expect(y === x, which).toBe(false); // compared here, not by expect(), which walks an iterable it is handed
      x.next();
      expect([...y].length, which).toBe(2);
      expect([...x].length, which).toBe(1);
    });
  });

  it('an empty collection iterates to done immediately', () => {
    for (const [which, it] of c.iterators(c.empty())) expect(it.next(), which).toEqual({ value: undefined, done: true });
    expect([...(c.empty() as Iterable<unknown>)]).toEqual([]);
  });

  it.skipIf(!hasIteratorHelpers)('the iterator helpers work on every iterator', () => {
    for (const [which, it] of c.iterators(c.of(1, 2, 3))) {
      expect(it.take(2).toArray().length, which).toBe(2);
    }
    for (const [which, it] of c.iterators(c.of(1, 2, 3))) {
      expect(it.map(() => 1).reduce((a, b) => a + b, 0), which).toBe(3);
    }
  });
});

describe('iterator helpers, by what they yield', () => {
  it.skipIf(!hasIteratorHelpers)('iterator helpers work on every iterator', () => {
    const m = ValueMap.from([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(m.values().map((v) => v * 2).toArray().sort()).toEqual([2, 4, 6]);
    expect(m.keys().filter((k) => k !== 'b').toArray().sort()).toEqual(['a', 'c']);
    expect(m.entries().take(2).toArray().length).toBe(2);
    expect(ValueSet.from([1, 2, 3]).values().reduce((a, b) => a + b, 0)).toBe(6);
    expect(ValueList.of(1, 2, 3)[Symbol.iterator]().some((x) => x === 2)).toBe(true);
    expect(ValueSet.from(['x']).entries().toArray()).toEqual([['x', 'x']]);
  });
});

describe('ValueMap iteration', () => {
  const entries = Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i] as const);
  const m = ValueMap.from(entries);

  it('keys, values, entries and the default iterator agree with each other and the map', () => {
    const ks = [...m.keys()];
    const vs = [...m.values()];
    const es = [...m.entries()];
    const ds = [...m];
    expect(ks.length).toBe(5_000);
    expect(vs.length).toBe(5_000);
    expect(es).toEqual(ds);
    expect(es.map(([k]) => k)).toEqual(ks);
    expect(es.map(([, v]) => v)).toEqual(vs);
    for (const [k, v] of es) expect(m.get(k)).toBe(v);
    expect(new Set(ks).size).toBe(5_000);
  });

  it('forEach visits every entry, in iteration order, with thisArg and the map', () => {
    const seen: [string, number][] = [];
    const ctx = { tag: 'ctx' };
    m.forEach(function (this: unknown, v, k, map) {
      expect(this).toBe(ctx);
      expect(map).toBe(m);
      seen.push([k, v]);
    }, ctx);
    expect(seen).toEqual([...m.entries()]);
  });
});

describe('ValueSet iteration', () => {
  const s = ValueSet.from(Array.from({ length: 5_000 }, (_, i) => `m${i}`));

  it('values, keys, entries and the default iterator agree', () => {
    const vs = [...s.values()];
    expect(vs.length).toBe(5_000);
    expect([...s.keys()]).toEqual(vs);
    expect([...s]).toEqual(vs);
    expect([...s.entries()]).toEqual(vs.map((v) => [v, v]));
    for (const v of vs) expect(s.has(v)).toBe(true);
  });

  it('forEach passes the member twice, thisArg, and the set', () => {
    const seen: string[] = [];
    s.forEach(function (this: unknown, v, v2, set) {
      expect(v2).toBe(v);
      expect(set).toBe(s);
      expect(this).toBe('ctx');
      seen.push(v);
    }, 'ctx');
    expect(seen).toEqual([...s]);
  });
});

describe('ValueList iteration', () => {
  it('streams the tree leaves then the tail, across every structural boundary', () => {
    // Leaf and branch boundaries are content-determined, so this is a spread
    // of sizes: empty, tail-only, and lists several branch levels tall.
    for (const n of [0, 1, 31, 32, 33, 64, 65, 1_023, 1_024, 1_025, 1_056, 1_057, 2_100]) {
      const items = Array.from({ length: n }, (_, i) => i);
      const list = ValueList.from(items);
      expect([...list]).toEqual(items);
      const seen: number[] = [];
      list.forEach((v, i) => {
        expect(i).toBe(seen.length);
        seen.push(v);
      });
      expect(seen).toEqual(items);
    }
  });

  it('forEach passes value, index, the list, and honours thisArg', () => {
    const list = ValueList.of('a', 'b', 'c');
    const out: string[] = [];
    list.forEach(function (this: unknown, v, i, l) {
      expect(l).toBe(list);
      expect(this).toBe(42);
      out.push(`${i}:${v}`);
    }, 42);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('iterates the same list as toArray() and get()', () => {
    const list = ValueList.from(Array.from({ length: 1_500 }, (_, i) => ({ n: i })));
    const viaIter = [...list];
    expect(viaIter).toEqual([...list.toArray()]);
    viaIter.forEach((v, i) => expect(list.get(i)).toBe(v)); // canonical element identity
  });
});
