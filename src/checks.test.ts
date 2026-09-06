import { describe, it, expect } from 'vitest';
import { intern, isCanonical, fastEquals } from './intern.js';
import { produce } from './produce.js';
import { FastMap, FastSet } from './fast-collections.js';
import { ValueList } from './value-list.js';
import { ValueDate } from './value-date.js';

describe('isCanonical', () => {
  it('primitives and symbols are their own canonical form; functions are not values', () => {
    for (const v of [1, 'a', true, null, undefined, 10n, NaN, Symbol('s'), Symbol.for('r')]) expect(isCanonical(v)).toBe(true);
    expect(isCanonical(() => 1)).toBe(false);
  });
  it('objects: what valsem canonicalised, and nothing else', () => {
    expect(isCanonical({ a: 1 })).toBe(false);
    expect(isCanonical([1])).toBe(false);
    expect(isCanonical(Object.freeze({ a: 1 }))).toBe(false); // frozen is not canonical
    expect(isCanonical(intern({ a: 1 }))).toBe(true);
    expect(isCanonical(intern([1, { b: 2 }])[1])).toBe(true);
    expect(isCanonical(produce(intern({ a: 1 }), (d) => void (d.a = 2)))).toBe(true);
    expect(isCanonical(ValueList.of(1))).toBe(true);
    expect(isCanonical(ValueDate.of(0))).toBe(true);
    expect(isCanonical(new Date(0))).toBe(false);
    class Foo {}
    expect(isCanonical(new Foo())).toBe(false);
  });
});

describe('the hash lives beside the value, not on it', () => {
  it('canonical values carry no extra own keys', () => {
    expect(Reflect.ownKeys(intern({ a: 1, b: [2] }))).toEqual(['a', 'b']);
    expect(Reflect.ownKeys(intern([1, 2]))).toEqual(['0', '1', 'length']);
  });
});

describe('fastEquals (checks on)', () => {
  it('is === on canonical values and primitives', () => {
    const a = intern({ x: [1, 2] });
    expect(fastEquals(a, intern({ x: [1, 2] }))).toBe(true);
    expect(fastEquals(a, intern({ x: [1, 3] }))).toBe(false);
    expect(fastEquals(1, 1)).toBe(true);
    expect(fastEquals(NaN, NaN)).toBe(false); // ===, by design — deepEqual says true
    expect(fastEquals(ValueList.of(1), ValueList.of(1))).toBe(true);
    expect(fastEquals(undefined, null)).toBe(false);
  });
  it('rejects raw arguments — the silent false — naming which side and what it was', () => {
    const c = intern({ x: 1 });
    expect(() => fastEquals({ x: 1 }, c)).toThrow(/first argument is a raw object/);
    expect(() => fastEquals(c, [1])).toThrow(/second argument is a raw array/);
    expect(() => fastEquals(c, () => 1)).toThrow(/a function/);
    class Foo {}
    expect(() => fastEquals(new Foo(), c)).toThrow(/an instance of Foo/);
    expect(() => fastEquals(c, { x: 1 })).toThrow(/skipChecks\(\) disables this check/);
  });
});

describe('FastMap and FastSet (checks on)', () => {
  it('are native Map/Set for canonical keys, and reject raw ones on every access', () => {
    const m = new FastMap<unknown, string>();
    const k = intern({ id: 1 });
    m.set(k, 'v').set(1, 'one').set('s', 'str');
    expect(m.get(intern({ id: 1 }))).toBe('v'); // canonical: === is value equality
    expect(m.get(1)).toBe('one');
    expect(m.has('s')).toBe(true);
    expect(m).toBeInstanceOf(Map);
    expect(m).toBeInstanceOf(FastMap);
    expect(m.size).toBe(3);
    for (const op of [() => m.get({ id: 1 }), () => m.has({ id: 1 }), () => m.set({ id: 1 }, 'x'), () => m.delete({ id: 1 })]) {
      expect(op).toThrow(/FastMap takes canonical keys only/);
    }
    expect(() => m.get({ id: 1 })).toThrow(/use HashMap to match by content/);
    expect(m.delete(k)).toBe(true);
    expect([...new FastMap([[intern({ a: 1 }), 1]]).keys()]).toEqual([intern({ a: 1 })]);

    const s = new FastSet<unknown>([intern({ x: 1 }), 2]);
    expect(s.has(intern({ x: 1 }))).toBe(true);
    expect(s.has(2)).toBe(true);
    expect(() => s.has({ x: 1 })).toThrow(/FastSet takes canonical elements only/);
    expect(() => s.add([1])).toThrow(/use HashSet to match by content/);
    expect(s).toBeInstanceOf(Set);
    expect(s.size).toBe(2);
  });
});
