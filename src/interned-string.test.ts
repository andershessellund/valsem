import { describe, expect, it } from 'vitest';
import { InternedString } from './interned-string.js';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';

describe('InternedString', () => {
  it('equal strings produce identical instances', () => {
    expect(InternedString.from('hello')).toBe(InternedString.from('hello'));
  });

  it('different strings produce distinct instances', () => {
    expect(InternedString.from('hello')).not.toBe(InternedString.from('world'));
  });

  it('empty string is canonical', () => {
    expect(InternedString.from('')).toBe(InternedString.from(''));
  });

  it('exposes value and toString', () => {
    const s = InternedString.from('abc');
    expect(s.value).toBe('abc');
    expect(s.toString()).toBe('abc');
    expect(`${s}`).toBe('abc');
  });

  it('exposes [hashCode] as number and [interned]', () => {
    const s = InternedString.from('abc');
    expect(typeof s[hashCode]).toBe('number');
    expect(s[interned]).toBe(true);
  });

  it('[equals] compares by value and rejects non-InternedStrings', () => {
    const s = InternedString.from('abc');
    expect(s[equals](InternedString.from('abc'))).toBe(true);
    expect(s[equals](InternedString.from('abd'))).toBe(false);
    expect(s[equals]('abc')).toBe(false);
    expect(s[equals]({ value: 'abc' })).toBe(false);
    expect(s[equals](null)).toBe(false);
  });

  it('for() rejects a non-string with a teaching error', () => {
    expect(() => InternedString.from(null as unknown as string)).toThrow(/expected a string/);
    expect(() => InternedString.from(42 as unknown as string)).toThrow(/expected a string/);
  });

  it('hashes as a wrapper, not as its string (they are different values)', () => {
    const s = InternedString.from('abc');
    expect(deepEqual(s, 'abc')).toBe(false);
    expect(deepEqual(s, InternedString.from('abc'))).toBe(true);
  });
});
