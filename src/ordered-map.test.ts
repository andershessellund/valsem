// ---------------------------------------------------------------------------
// OrderedMap — the insertion-ordered persistent map: order is part of the
// value, every operation is O(log n) through anchors, instances are
// canonical. The property suite (property-ordered.test.ts) drives random
// op sequences; this file pins the semantics one case at a time.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { OrderedMap } from './ordered-map.js';
import { ValueMap } from './value-map.js';
import { ValueList } from './value-list.js';
import { intern } from './intern.js';
import { deepEqual, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { HashMap } from './hash-map.js';
import { ValueDate } from './value-date.js';
import { runStarts } from './ordered.test-helpers.js';


const abc = () =>
  OrderedMap.from<string, number>([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);

describe('OrderedMap — identity', () => {
  it('empty maps are one instance, and from([]) is empty', () => {
    expect(OrderedMap.empty()).toBe(OrderedMap.empty());
    expect(OrderedMap.from([])).toBe(OrderedMap.empty());
    expect(OrderedMap.fromObject({})).toBe(OrderedMap.empty());
  });

  it('equal entry sequences are the same object, however built', () => {
    const viaSet = OrderedMap.empty<string, number>().with('a', 1).with('b', 2).with('c', 3);
    const viaObject = OrderedMap.fromObject({ a: 1, b: 2, c: 3 });
    const viaDetour = abc().with('d', 4).deleted('d').with('b', 99).with('b', 2);
    expect(viaSet).toBe(abc());
    expect(viaObject).toBe(abc());
    expect(viaDetour).toBe(abc());
  });

  it('order is part of the value — unlike ValueMap', () => {
    const ab = OrderedMap.from([
      ['a', 1],
      ['b', 2],
    ]);
    const ba = OrderedMap.from([
      ['b', 2],
      ['a', 1],
    ]);
    expect(ab).not.toBe(ba);
    expect(deepEqual(ab, ba)).toBe(false);
    expect(ValueMap.from(ab)).toBe(ValueMap.from(ba));
  });

  it('is a value: marked [interned], hashed, pooled by intern, a HashMap key', () => {
    const m = abc();
    expect(m[interned]).toBe(true);
    expect(intern(m)).toBe(m);
    expect(typeof m[hashCode]).toBe('number');
    expect(deepHash(m)).toBe(m[hashCode]);
    expect(deepEqual(m, abc())).toBe(true);
    expect(new HashMap().set(m, 'x').get(abc())).toBe('x');
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('keyList and valueList are the canonical lists; the key list is shared across value changes', () => {
    const m = abc();
    expect(m.keyList).toBe(ValueList.of('a', 'b', 'c'));
    expect(m.valueList).toBe(ValueList.of(1, 2, 3));
    const changed = m.with('b', 20);
    expect(changed.keyList).toBe(m.keyList);
    expect(changed.valueList).not.toBe(m.valueList);
  });
});

describe('OrderedMap — reads', () => {
  it('get / has / size / indexOf / keyAt / valueAt / at / first / last', () => {
    const m = abc();
    expect(m.size).toBe(3);
    expect(m.get('b')).toBe(2);
    expect(m.get('z')).toBeUndefined();
    expect(m.has('c')).toBe(true);
    expect(m.has('z')).toBe(false);
    expect(m.indexOf('a')).toBe(0);
    expect(m.indexOf('c')).toBe(2);
    expect(m.indexOf('z')).toBe(-1);
    expect(m.at(1)).toEqual(['b', 2]);
    expect(m.keyList.at(1)).toBe('b');
    expect(m.valueList.at(1)).toBe(2);
    expect(m.at(2)).toEqual(['c', 3]);
    expect(m.at(3)).toBeUndefined(); // as Array.prototype.at
    expect(m.at(-1)).toEqual(['c', 3]);
    expect(m.at(-4)).toBeUndefined();
    expect(m.first()).toEqual(['a', 1]);
    expect(m.last()).toEqual(['c', 3]);
    expect(OrderedMap.empty().first()).toBeUndefined();
    expect(OrderedMap.empty().indexOf('a')).toBe(-1);
  });

  it('probes are canonicalized: a structurally equal raw key finds the entry', () => {
    const m = OrderedMap.from([[{ id: 1, tag: 'x' }, 'one']]);
    expect(m.get({ tag: 'x', id: 1 })).toBe('one');
    expect(m.has({ tag: 'x', id: 1 })).toBe(true);
    expect(m.indexOf({ tag: 'x', id: 1 })).toBe(0);
    expect(m.with({ tag: 'x', id: 1 }, 'one')).toBe(m);
  });

  it('iterates in insertion order: entries, keys, values, forEach, spread, new Map', () => {
    const m = abc();
    expect([...m]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect([...m.keys()]).toEqual(['a', 'b', 'c']);
    expect([...m.values()]).toEqual([1, 2, 3]);
    expect([...m.entries()]).toEqual([...m]);
    const seen: [string, number, unknown][] = [];
    m.forEach(function (this: unknown, v, k, map) {
      expect(map).toBe(m);
      seen.push([k, v, this]);
    }, 'ctx');
    expect(seen).toEqual([
      ['a', 1, 'ctx'],
      ['b', 2, 'ctx'],
      ['c', 3, 'ctx'],
    ]);
    expect(new Map(m).get('c')).toBe(3);
    // The iterators are iterator objects: the ES2025 helpers apply.
    expect(m.keys().map((k) => k.toUpperCase()).toArray()).toEqual(['A', 'B', 'C']);
    expect(m.entries().filter(([, v]) => v > 1).toArray()).toEqual([
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('OrderedMap — writes', () => {
  it('set on a present key keeps its position; a new key appends', () => {
    const m = abc().with('b', 20).with('d', 4);
    expect([...m]).toEqual([
      ['a', 1],
      ['b', 20],
      ['c', 3],
      ['d', 4],
    ]);
  });

  it('set with the same value returns this', () => {
    const m = abc();
    expect(m.with('b', 2)).toBe(m);
  });

  it('delete removes; delete then set moves the key to the end (native Map semantics)', () => {
    const m = abc();
    expect([...m.deleted('b').keys()]).toEqual(['a', 'c']);
    expect(m.deleted('z')).toBe(m);
    expect([...m.deleted('a').with('a', 1).keys()]).toEqual(['b', 'c', 'a']);
    expect(m.deleted('a').deleted('b').deleted('c')).toBe(OrderedMap.empty());
  });

  it('insertAt places a new entry; the end is an append; a present key or bad index throws', () => {
    const m = abc();
    expect([...m.insertedAt(0, 'z', 0).keys()]).toEqual(['z', 'a', 'b', 'c']);
    expect([...m.insertedAt(1, 'z', 0).keys()]).toEqual(['a', 'z', 'b', 'c']);
    expect(m.insertedAt(3, 'z', 0)).toBe(m.with('z', 0));
    expect(() => m.insertedAt(1, 'b', 0)).toThrow(/already present/);
    expect(() => m.insertedAt(4, 'z', 0)).toThrow(RangeError);
    expect(() => m.insertedAt(-1, 'z', 0)).toThrow(RangeError);
    expect(() => m.insertedAt(1.5, 'z', 0)).toThrow(RangeError);
  });

  it('values and keys are interned on entry: raw records come back canonical and frozen', () => {
    const m = OrderedMap.empty<string, { n: number }>().with('a', { n: 1 });
    const v = m.get('a')!;
    expect(v).toBe(intern({ n: 1 }));
    expect(Object.isFrozen(v)).toBe(true);
    expect(m).toBe(OrderedMap.from([['a', { n: 1 }]]));
  });

  it('stored undefined is a real entry; fromObject drops undefined (record semantics)', () => {
    const m = OrderedMap.empty<string, number | undefined>().with('a', undefined);
    expect(m.size).toBe(1);
    expect(m.has('a')).toBe(true);
    expect(m.get('a')).toBeUndefined();
    expect(OrderedMap.fromObject({ a: 1, b: undefined, c: 3 })).toBe(
      OrderedMap.from([
        ['a', 1],
        ['c', 3],
      ]),
    );
  });

  it('from: a key given twice keeps its first position and last value; NaN is one key', () => {
    expect(
      OrderedMap.from([
        ['a', 1],
        ['b', 2],
        ['a', 3],
      ]),
    ).toBe(
      OrderedMap.from([
        ['a', 3],
        ['b', 2],
      ]),
    );
    const nan = OrderedMap.from<number, string>([
      [NaN, 'x'],
      [1, 'y'],
      [NaN, 'z'],
    ]);
    expect(nan.size).toBe(2);
    expect(nan.get(NaN)).toBe('z');
    expect(nan.indexOf(NaN)).toBe(0);
    expect(nan.deleted(NaN).size).toBe(1);
  });

  it('undefined is a legitimate key, including where it starts a run and so anchors other keys', () => {
    // Build a list long enough for several runs, with `undefined` placed at
    // the start of every run in turn: the key after it anchors to it, and a
    // lookup must not read that anchor as "absent".
    const N = 300;
    const base = Array.from({ length: N }, (_, i) => [`k${i}`, i] as [unknown, number]);
    const starts = runStarts(OrderedMap.from(base).keyList);
    expect(starts.length).toBeGreaterThan(2);
    for (const at of [...starts, 5, N]) {
      const entries = base.slice();
      entries.splice(at, 0, [undefined, -1]);
      const m = OrderedMap.from(entries);
      expect(m.size).toBe(N + 1);
      expect(m.has(undefined)).toBe(true);
      expect(m.get(undefined)).toBe(-1);
      expect(m.indexOf(undefined)).toBe(at);
      for (let i = 0; i < entries.length; i += 5) expect(m.indexOf(entries[i]![0])).toBe(i);
      // The same value built incrementally, then edited around the undefined key.
      const inc = OrderedMap.from(base).insertedAt(at, undefined, -1);
      expect(inc).toBe(m);
      const next = inc.deleted(entries[Math.min(at + 1, N)]![0]).with('z', 0);
      for (let i = 0; i < next.size; i += 5) expect(next.indexOf(next.at(i)![0])).toBe(i);
      expect(next.deleted(undefined).has(undefined)).toBe(false);
    }
  });

  it('rejects non-value keys and values with the teaching error', () => {
    expect(() => OrderedMap.empty<Date, number>().with(new Date(0), 1)).toThrow(/ValueDate/);
    expect(() => OrderedMap.empty<string, Map<string, string>>().with('a', new Map())).toThrow(/ValueMap/);
    expect(OrderedMap.empty<string, ValueDate>().with('a', ValueDate.from(0)).get('a')).toBe(ValueDate.from(0));
  });
});

describe('OrderedMap — sizes across tree levels', () => {
  it('every key finds its position after builds, deletes and inserts at 3,000 entries', () => {
    const N = 3000;
    const entries = Array.from({ length: N }, (_, i) => [`k${i}`, i] as [string, number]);
    let m = OrderedMap.from(entries);
    expect(m.keyList._height).toBeGreaterThanOrEqual(2);
    const model = entries.slice();
    const check = (): void => {
      expect(m.size).toBe(model.length);
      for (let i = 0; i < model.length; i += 7) {
        expect(m.indexOf(model[i]![0])).toBe(i);
        expect(m.at(i)![0]).toBe(model[i]![0]);
      }
      expect([...m.keys()]).toEqual(model.map(([k]) => k));
    };
    check();
    // Deletes spread across the list, front and back included.
    for (const k of ['k0', 'k1', 'k1500', 'k2000', 'k2999', 'k2998']) {
      m = m.deleted(k);
      model.splice(
        model.findIndex(([x]) => x === k),
        1,
      );
    }
    check();
    for (const [i, k] of [
      [0, 'n0'],
      [1000, 'n1'],
      [model.length, 'n2'],
    ] as [number, string][]) {
      m = m.insertedAt(i, k, -1);
      model.splice(i, 0, [k, -1]);
    }
    check();
    expect(m).toBe(OrderedMap.from(model));
  });
});

describe('OrderedMap — what is not a key has no position and no anchor', () => {
  it('indexOf is -1 and the anchor inspector answers undefined, for a raw probe too', () => {
    const m = abc();
    expect(m.indexOf('missing')).toBe(-1);
    expect(m._anchorOf('missing')).toBeUndefined();
    expect(OrderedMap.empty<unknown, number>()._anchorOf({ raw: 1 })).toBeUndefined();
    expect(m._anchorOf('a')).not.toBeUndefined();
  });
});

describe('OrderedMap.from reads entries as new Map does', () => {
  it('by their 0 and 1: an array-like is an entry, a string is not', () => {
    expect(OrderedMap.from([{ 0: 'k', 1: 'v' } as unknown as [string, string]]).get('k')).toBe('v');
    expect(() => OrderedMap.from(['ab'] as unknown as [string, string][])).toThrow(/is not an entry object/);
  });
});
