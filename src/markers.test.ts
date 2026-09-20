// ---------------------------------------------------------------------------
// The protocol markers on valsem's own value types are prototype getters over
// a private field: no own symbol property exists, so a spread or Object.assign
// copy carries no marker and cannot pass for canonical.
//
// A law of every value type, so it runs over the roster.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { hashCode, interned, deepEqual } from './deep-equal.js';
import { intern, isCanonical } from './intern.js';
import { deepHash } from './deep-hash.js';
import { InternedString } from './interned-string.js';
import { VALUE_TYPES } from './roster.test-helpers.js';

describe.each(VALUE_TYPES.map((t) => [t.name, t.sample()] as const))('%s markers', (_name, v) => {
  it('answer the protocol without being own properties', () => {
    expect((v as Record<symbol, unknown>)[interned]).toBe(true);
    expect(typeof (v as Record<symbol, unknown>)[hashCode]).toBe('number');
    expect(Object.getOwnPropertySymbols(v)).toEqual([]);
    expect(Object.hasOwn(v, hashCode)).toBe(false);
    expect(isCanonical(v)).toBe(true);
    expect(deepHash(v)).toBe((v as Record<symbol, unknown>)[hashCode]);
  });

  it('a spread or assign copy carries no marker and is not canonical', () => {
    const spread = { ...v };
    const assigned = Object.assign({}, v);
    for (const copy of [spread, assigned]) {
      expect(interned in copy).toBe(false);
      expect(hashCode in copy).toBe(false);
      expect(isCanonical(copy)).toBe(false);
      expect(deepEqual(copy, v)).toBe(false); // a plain record is not the value type
      const c = intern(copy);
      expect(c).not.toBe(v);
      expect(Object.isFrozen(c)).toBe(true); // interned as the plain record it is
    }
  });
});

describe('InternedString — JSON parity', () => {
  it('stringifies as the text, like a string', () => {
    const s = InternedString.for('hello');
    expect(JSON.stringify({ s })).toBe('{"s":"hello"}');
    expect(String(s)).toBe('hello');
    expect(`${s}`).toBe('hello');
    expect(InternedString.for(JSON.parse(JSON.stringify({ s })).s)).toBe(s);
  });
});
