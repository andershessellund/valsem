// ---------------------------------------------------------------------------
// intern — tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { intern, internHash, internEqual } from './intern.js';

describe('intern', () => {
  it('returns primitives unchanged', () => {
    expect(intern(42)).toBe(42);
    expect(intern('hello')).toBe('hello');
    expect(intern(true)).toBe(true);
    expect(intern(null)).toBe(null);
    expect(intern(undefined)).toBe(undefined);
  });

  it('canonicalizes structurally equal plain objects', () => {
    const a = intern({ x: 1, y: 2 });
    const b = intern({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('canonicalizes structurally equal arrays', () => {
    const a = intern([1, 2, 3]);
    const b = intern([1, 2, 3]);
    expect(a).toBe(b);
  });

  it('recursively interns nested values', () => {
    const a = intern({ inner: { x: 1 } });
    const b = intern({ inner: { x: 1 } });
    expect(a).toBe(b);
    expect((a as { inner: object }).inner).toBe((b as { inner: object }).inner);
  });

  it('freezes interned objects', () => {
    const obj = intern({ x: 1 });
    expect(Object.isFrozen(obj)).toBe(true);
  });

  it('returns class instances unchanged', () => {
    class Foo { x = 1; }
    const f = new Foo();
    expect(intern(f)).toBe(f);
  });
});

describe('internHash', () => {
  it('returns same hash for structurally equal values', () => {
    expect(internHash({ a: 1, b: 2 })).toBe(internHash({ b: 2, a: 1 }));
  });

  it('uses cached hash for interned objects', () => {
    const obj = intern({ x: 1 });
    // First call computes and stores; subsequent calls hit cache.
    const h1 = internHash(obj);
    const h2 = internHash(obj);
    expect(h1).toBe(h2);
  });
});

describe('internEqual', () => {
  it('returns true for === values', () => {
    expect(internEqual(42, 42)).toBe(true);
    const obj = {};
    expect(internEqual(obj, obj)).toBe(true);
  });

  it('returns true for structurally equal values via interning', () => {
    expect(internEqual({ a: 1 }, { a: 1 })).toBe(true);
  });

  it('returns false for distinct interned objects with same hash', () => {
    const a = intern({ x: 1 });
    const b = intern({ x: 2 });
    expect(internEqual(a, b)).toBe(false);
  });
});

describe('intern — canonical form drops undefined-valued keys', () => {
  it('{a: undefined} and {} intern to the same instance', () => {
    expect(intern({ a: undefined })).toBe(intern({}));
    expect(intern({ a: undefined, b: 1 })).toBe(intern({ b: 1 }));
  });

  it('the canonical record has the key absent, not present-undefined', () => {
    const c = intern({ a: undefined, b: 1 });
    expect('a' in c).toBe(false);
    expect(Object.keys(c)).toEqual(['b']);
  });
});

describe('intern — hostile record keys', () => {
  it('interns JSON.parse output carrying __proto__ as a plain record', () => {
    const a = intern(JSON.parse('{"__proto__": {"x": 1}, "b": 2}')) as object;
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.keys(a).sort()).toEqual(['__proto__', 'b']);
    expect(intern(JSON.parse('{"b": 2, "__proto__": {"x": 1}}'))).toBe(a);
  });
});

describe('intern — NaN-containing values are canonical too', () => {
  it('intern([NaN]) === intern([NaN])', () => {
    expect(intern([NaN])).toBe(intern([NaN]));
    expect(intern({ x: NaN })).toBe(intern({ x: NaN }));
    expect(intern([NaN, 1])).not.toBe(intern([1, NaN]));
  });
});
