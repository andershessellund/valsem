import { describe, expect, it } from 'vitest';
import { InternString } from './intern-string.js';
import { hashCode, interned } from './deep-equal.js';

describe('InternString', () => {
  it('equal strings produce identical instances', () => {
    expect(InternString.for('hello')).toBe(InternString.for('hello'));
  });

  it('different strings produce distinct instances', () => {
    expect(InternString.for('hello')).not.toBe(InternString.for('world'));
  });

  it('empty string is canonical', () => {
    expect(InternString.for('')).toBe(InternString.for(''));
  });

  it('exposes value and toString', () => {
    const s = InternString.for('abc');
    expect(s.value).toBe('abc');
    expect(s.toString()).toBe('abc');
    expect(`${s}`).toBe('abc');
  });

  it('exposes [hashCode] as number and [interned]', () => {
    const s = InternString.for('abc');
    expect(typeof s[hashCode]).toBe('number');
    expect(s[interned]).toBe(true);
  });
});
