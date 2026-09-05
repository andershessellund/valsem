// ---------------------------------------------------------------------------
// Algebraic laws of deepEqual, and the two implications the package rests on.
//
// The other property suites test canonicality against independently-built
// equals; this one tests the RELATION itself — reflexive, symmetric,
// transitive — over the same value domain, on both equal and unrelated
// pairs, and pins the two consequences: equal ⟹ same hash, equal ⟹ same
// canonical instance, and interning never changes a verdict.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deepEqual, equals } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { valueTree, shuffledClone, mulberry32 } from './property.test-helpers.js';

describe('property — deepEqual is an equivalence relation', () => {
  it('reflexive: deepEqual(v, v) for every value', () => {
    fc.assert(
      fc.property(valueTree, (v) => {
        expect(deepEqual(v, v)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('symmetric: deepEqual(a, b) === deepEqual(b, a), on equal AND unrelated pairs', () => {
    fc.assert(
      fc.property(valueTree, valueTree, fc.integer(), (a, b, seed) => {
        const twin = shuffledClone(a, mulberry32(seed));
        expect(deepEqual(a, twin)).toBe(true);
        expect(deepEqual(twin, a)).toBe(true);
        expect(deepEqual(a, b)).toBe(deepEqual(b, a));
      }),
      { numRuns: 300 },
    );
  });

  it('transitive: two independent twins of a are equal to each other', () => {
    fc.assert(
      fc.property(valueTree, fc.integer(), fc.integer(), (a, s1, s2) => {
        const t1 = shuffledClone(a, mulberry32(s1));
        const t2 = shuffledClone(a, mulberry32(s2));
        expect(deepEqual(a, t1)).toBe(true);
        expect(deepEqual(t1, t2)).toBe(true);
        expect(deepEqual(a, t2)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('symmetric when only one side carries an own [equals] (the plain-object corner)', () => {
    const a: Record<PropertyKey, unknown> = { x: 1, [equals]: () => true };
    const b = { x: 1 };
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(b, a)).toBe(false);
  });
});

describe('property — the two implications', () => {
  it('deepEqual(a, b) ⟹ deepHash(a) === deepHash(b), including across interning', () => {
    fc.assert(
      fc.property(valueTree, fc.integer(), (a, seed) => {
        const twin = shuffledClone(a, mulberry32(seed));
        expect(deepHash(a)).toBe(deepHash(twin));
        expect(deepHash(intern(a))).toBe(deepHash(twin));
      }),
      { numRuns: 300 },
    );
  });

  it('deepEqual(a, b) ⟹ intern(a) === intern(b), and interning never changes the verdict', () => {
    fc.assert(
      fc.property(valueTree, valueTree, fc.integer(), (a, b, seed) => {
        const twin = shuffledClone(a, mulberry32(seed));
        const ia = intern(a);
        expect(intern(twin)).toBe(ia);
        expect(deepEqual(ia, intern(twin))).toBe(true);
        // Unrelated pair: the answer is the same before and after interning,
        // on either side or both.
        const before = deepEqual(a, b);
        expect(deepEqual(ia, intern(b))).toBe(before);
        expect(deepEqual(ia, b)).toBe(before);
        expect(deepEqual(a, intern(b))).toBe(before);
      }),
      { numRuns: 300 },
    );
  });
});
