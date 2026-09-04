import { describe, expect, it } from 'vitest';
import { InternedString } from './interned-string.js';
import { hashCode, interned } from './deep-equal.js';

describe('InternedString', () => {
  it('equal strings produce identical instances', () => {
    expect(InternedString.for('hello')).toBe(InternedString.for('hello'));
  });

  it('different strings produce distinct instances', () => {
    expect(InternedString.for('hello')).not.toBe(InternedString.for('world'));
  });

  it('empty string is canonical', () => {
    expect(InternedString.for('')).toBe(InternedString.for(''));
  });

  it('exposes value and toString', () => {
    const s = InternedString.for('abc');
    expect(s.value).toBe('abc');
    expect(s.toString()).toBe('abc');
    expect(`${s}`).toBe('abc');
  });

  it('exposes [hashCode] as number and [interned]', () => {
    const s = InternedString.for('abc');
    expect(typeof s[hashCode]).toBe('number');
    expect(s[interned]).toBe(true);
  });
});
