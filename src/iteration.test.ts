// Iteration protocol of the three collections: explicit-stack iterator
// objects (not generators), so the protocol details are pinned here —
// done-state, fresh iterators per call, iterator helpers where the runtime
// has them, forEach signatures, and the structural boundaries (trie levels,
// trunk/tail, multi-level trunk) that the stacks must cross correctly.
import { describe, it, expect } from 'vitest';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';

const hasIteratorHelpers = typeof (globalThis as { Iterator?: unknown }).Iterator === 'function';

describe('iterator protocol', () => {
  it('every iterator is its own iterable, reports done once, and stays done', () => {
    const iters: IterableIterator<unknown>[] = [
      ValueMap.from([['a', 1]]).keys(),
      ValueMap.from([['a', 1]]).values(),
      ValueMap.from([['a', 1]]).entries(),
      ValueMap.from([['a', 1]])[Symbol.iterator](),
      ValueSet.from(['a']).values(),
      ValueSet.from(['a']).entries(),
      ValueList.of('a')[Symbol.iterator](),
    ];
    for (const it of iters) {
      expect(it[Symbol.iterator]()).toBe(it);
      expect(it.next().done).toBe(false);
      const end = it.next();
      expect(end).toEqual({ value: undefined, done: true });
      expect(it.next()).toEqual({ value: undefined, done: true });
    }
  });

  it('each call returns a fresh, independent iterator', () => {
    const m = ValueMap.from([
      ['a', 1],
      ['b', 2],
    ]);
    const x = m.keys();
    const y = m.keys();
    x.next();
    expect([...y].length).toBe(2);
    expect([...x].length).toBe(1);
    expect([...m.keys()].length).toBe(2);
  });

  it('empty collections iterate to done immediately', () => {
    expect([...ValueMap.empty()]).toEqual([]);
    expect([...ValueMap.empty().values()]).toEqual([]);
    expect([...ValueSet.empty()]).toEqual([]);
    expect([...ValueSet.empty().entries()]).toEqual([]);
    expect([...ValueList.empty()]).toEqual([]);
    expect(ValueMap.empty().keys().next()).toEqual({ value: undefined, done: true });
  });

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
  it('streams trunk leaves then the tail, across every structural boundary', () => {
    // 0 (empty), tail-only, exactly one leaf, leaf + partial tail, two levels,
    // exactly full levels, three levels, and a partial tail after three levels.
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
