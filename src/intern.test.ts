// ---------------------------------------------------------------------------
// intern — tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { intern, internHash } from './intern.js';

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

// internEqual was deleted: a side-effecting equality predicate (its fallback
// interned — froze and pooled — its arguments). deepEqual's canonical fast
// path covers its short-circuits; `intern(a) === intern(b)` states adoption
// semantics explicitly for callers who want them.

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

describe('intern — key order is layout, not value', () => {
  it('the first spelling seen sets the canonical layout; every spelling is the same object', () => {
    const first = intern({ zeta: 1, alpha: 2, mid: 3 });
    expect(intern({ alpha: 2, mid: 3, zeta: 1 })).toBe(first);
    expect(intern({ mid: 3, zeta: 1, alpha: 2 })).toBe(first);
    expect(new Set(Object.keys(first))).toEqual(new Set(['zeta', 'alpha', 'mid']));
    expect(deepEqual(first, { alpha: 2, mid: 3, zeta: 1 })).toBe(true);
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
