import { describe, expect, it } from 'vitest';
import { ValueList } from './value-list.js';
import { equals, hashCode, interned } from './deep-equal.js';

describe('ValueList', () => {
  it('empty arrays are identical', () => {
    expect(ValueList.empty<number>()).toBe(ValueList.empty<number>());
    expect(ValueList.from([])).toBe(ValueList.empty<number>());
  });

  it('equal arrays are reference-identical', () => {
    const a = ValueList.of(1, 2, 3);
    const b = ValueList.of(1, 2, 3);
    expect(a).toBe(b);
  });

  it('different arrays are not identical', () => {
    expect(ValueList.of(1, 2, 3)).not.toBe(ValueList.of(1, 2, 4));
    expect(ValueList.of(1, 2, 3)).not.toBe(ValueList.of(3, 2, 1));
    expect(ValueList.of(1, 2)).not.toBe(ValueList.of(1, 2, 3));
  });

  it('exposes [hashCode] as a number property', () => {
    const a = ValueList.of(1, 2, 3);
    expect(typeof a[hashCode]).toBe('number');
    expect(a[hashCode]).toBe(ValueList.of(1, 2, 3)[hashCode]);
  });

  it('marks instances as [interned]', () => {
    expect(ValueList.of(1)[interned]).toBe(true);
    expect(ValueList.empty()[interned]).toBe(true);
  });

  it('push: incremental hash matches from-scratch', () => {
    const a = ValueList.of(1, 2, 3);
    const b = a.push(4);
    expect(b).toBe(ValueList.of(1, 2, 3, 4));
    expect(b[hashCode]).toBe(ValueList.of(1, 2, 3, 4)[hashCode]);
  });

  it('push: pool hit avoids new allocation', () => {
    const target = ValueList.of('x', 'y');
    const built = ValueList.of('x').push('y');
    expect(built).toBe(target);
  });

  it('pop: incremental hash matches from-scratch', () => {
    const a = ValueList.of(1, 2, 3, 4);
    const b = a.pop();
    expect(b).toBe(ValueList.of(1, 2, 3));
  });

  it('pop on empty returns this', () => {
    const e = ValueList.empty<number>();
    expect(e.pop()).toBe(e);
  });

  it('set: incremental hash matches from-scratch', () => {
    const a = ValueList.of('a', 'b', 'c');
    const b = a.set(1, 'B');
    expect(b).toBe(ValueList.of('a', 'B', 'c'));
  });

  it('set with same value returns this', () => {
    const a = ValueList.of(1, 2, 3);
    expect(a.set(1, 2)).toBe(a);
  });

  it('set out of range throws', () => {
    const a = ValueList.of(1, 2);
    expect(() => a.set(5, 9)).toThrow(RangeError);
    expect(() => a.set(-1, 9)).toThrow(RangeError);
  });

  it('exposes underlying array (frozen)', () => {
    const a = ValueList.of(1, 2, 3);
    expect(Array.isArray(a.array)).toBe(true);
    expect(Object.isFrozen(a.array)).toBe(true);
    expect([...a]).toEqual([1, 2, 3]);
  });

  it('[equals] uses kind discriminator', () => {
    const a = ValueList.of(1);
    expect(a[equals](ValueList.of(1))).toBe(true);
    expect(a[equals]({})).toBe(false);
    expect(a[equals]([1])).toBe(false);
  });

  it('round-trip push/pop produces same instance', () => {
    const a = ValueList.of(1, 2, 3);
    expect(a.push(4).pop()).toBe(a);
  });
});
