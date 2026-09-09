import { describe, it, expect } from 'vitest';
import { intern, isCanonical, fastEquals } from './intern.js';
import { produce } from './produce.js';
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
