import { describe, expect, it } from 'vitest';
import { InternArray } from './intern-array.js';
import { equals, hashCode, interned } from './deep-equal.js';

describe('InternArray', () => {
  it('empty arrays are identical', () => {
    expect(InternArray.empty<number>()).toBe(InternArray.empty<number>());
    expect(InternArray.from([])).toBe(InternArray.empty<number>());
  });

  it('equal arrays are reference-identical', () => {
    const a = InternArray.of(1, 2, 3);
    const b = InternArray.of(1, 2, 3);
    expect(a).toBe(b);
  });

  it('different arrays are not identical', () => {
    expect(InternArray.of(1, 2, 3)).not.toBe(InternArray.of(1, 2, 4));
    expect(InternArray.of(1, 2, 3)).not.toBe(InternArray.of(3, 2, 1));
    expect(InternArray.of(1, 2)).not.toBe(InternArray.of(1, 2, 3));
  });

  it('exposes [hashCode] as a number property', () => {
    const a = InternArray.of(1, 2, 3);
    expect(typeof a[hashCode]).toBe('number');
    expect(a[hashCode]).toBe(InternArray.of(1, 2, 3)[hashCode]);
  });

  it('marks instances as [interned]', () => {
    expect(InternArray.of(1)[interned]).toBe(true);
    expect(InternArray.empty()[interned]).toBe(true);
  });

  it('push: incremental hash matches from-scratch', () => {
    const a = InternArray.of(1, 2, 3);
    const b = a.push(4);
    expect(b).toBe(InternArray.of(1, 2, 3, 4));
    expect(b[hashCode]).toBe(InternArray.of(1, 2, 3, 4)[hashCode]);
  });

  it('push: pool hit avoids new allocation', () => {
    const target = InternArray.of('x', 'y');
    const built = InternArray.of('x').push('y');
    expect(built).toBe(target);
  });

  it('pop: incremental hash matches from-scratch', () => {
    const a = InternArray.of(1, 2, 3, 4);
    const b = a.pop();
    expect(b).toBe(InternArray.of(1, 2, 3));
  });

  it('pop on empty returns this', () => {
    const e = InternArray.empty<number>();
    expect(e.pop()).toBe(e);
  });

  it('set: incremental hash matches from-scratch', () => {
    const a = InternArray.of('a', 'b', 'c');
    const b = a.set(1, 'B');
    expect(b).toBe(InternArray.of('a', 'B', 'c'));
  });

  it('set with same value returns this', () => {
    const a = InternArray.of(1, 2, 3);
    expect(a.set(1, 2)).toBe(a);
  });

  it('set out of range throws', () => {
    const a = InternArray.of(1, 2);
    expect(() => a.set(5, 9)).toThrow(RangeError);
    expect(() => a.set(-1, 9)).toThrow(RangeError);
  });

  it('exposes underlying array (frozen)', () => {
    const a = InternArray.of(1, 2, 3);
    expect(Array.isArray(a.array)).toBe(true);
    expect(Object.isFrozen(a.array)).toBe(true);
    expect([...a]).toEqual([1, 2, 3]);
  });

  it('[equals] uses kind discriminator', () => {
    const a = InternArray.of(1);
    expect(a[equals](InternArray.of(1))).toBe(true);
    expect(a[equals]({})).toBe(false);
    expect(a[equals]([1])).toBe(false);
  });

  it('round-trip push/pop produces same instance', () => {
    const a = InternArray.of(1, 2, 3);
    expect(a.push(4).pop()).toBe(a);
  });
});
