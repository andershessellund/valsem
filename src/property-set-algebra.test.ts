// ---------------------------------------------------------------------------
// Node-level set algebra, against the one exact oracle: `ValueSet.from` of
// the array-level answer. Both sides are canonical, so `toBe` checks shape
// canonicality as well as content — a merge that reached the right members
// by a non-canonical shape would be a different root, and fail.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueSet } from './value-set.js';
import { intern } from './intern.js';

/** Small ints so operands overlap; records so members are objects. */
const ints = fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 80 });
const recs = fc.array(fc.record({ x: fc.integer({ min: 0, max: 20 }), y: fc.boolean() }), { maxLength: 40 });
const mixed = fc.array(
  fc.oneof(fc.integer({ min: 0, max: 30 }), fc.string({ maxLength: 2 }), fc.record({ x: fc.integer({ min: 0, max: 8 }) })),
  { maxLength: 60 },
);

function oracle<T>(xs: readonly T[], ys: readonly T[]) {
  const A = ValueSet.from(xs);
  const B = ValueSet.from(ys);
  const inA = (v: unknown): boolean => A.has(v as T);
  const inB = (v: unknown): boolean => B.has(v as T);
  return {
    A,
    B,
    union: ValueSet.from([...xs, ...ys]),
    intersection: ValueSet.from(xs.filter(inB)),
    difference: ValueSet.from(xs.filter((v) => !inB(v))),
    symmetric: ValueSet.from([...xs.filter((v) => !inB(v)), ...ys.filter((v) => !inA(v))]),
    subset: [...A].every(inB),
    disjoint: ![...A].some(inB),
  };
}

function checkAll(xs: readonly unknown[], ys: readonly unknown[]): void {
  const o = oracle(xs, ys);
  const { A, B } = o;
  expect(A.union(B)).toBe(o.union);
  expect(B.union(A)).toBe(o.union);
  expect(A.intersection(B)).toBe(o.intersection);
  expect(B.intersection(A)).toBe(o.intersection);
  expect(A.difference(B)).toBe(o.difference);
  expect(A.symmetricDifference(B)).toBe(o.symmetric);
  expect(B.symmetricDifference(A)).toBe(o.symmetric);
  expect(A.isSubsetOf(B)).toBe(o.subset);
  expect(B.isSupersetOf(A)).toBe(o.subset);
  expect(A.isDisjointFrom(B)).toBe(o.disjoint);
  expect(B.isDisjointFrom(A)).toBe(o.disjoint);
  // Sizes come from the root and must agree with a walk.
  for (const s of [o.union, o.intersection, o.difference, o.symmetric]) {
    expect(s.size).toBe([...s].length);
  }
  // Raw iterables are the same operands.
  expect(A.union(ys)).toBe(o.union);
  expect(A.intersection(new Set(ys))).toBe(o.intersection);
  expect(A.difference(ys)).toBe(o.difference);
  expect(A.symmetricDifference(ys)).toBe(o.symmetric);
  expect(A.isSubsetOf(ys)).toBe(o.subset);
  expect(A.isSupersetOf(ys)).toBe(B.isSubsetOf(A));
  expect(A.isDisjointFrom(ys)).toBe(o.disjoint);
  // Laws.
  expect(A.union(B)).toBe(A.union(B.difference(A)));
  expect(A.symmetricDifference(B)).toBe(A.union(B).difference(A.intersection(B)));
  expect(A.intersection(B).isSubsetOf(A)).toBe(true);
  expect(A.difference(B).isDisjointFrom(B)).toBe(true);
  expect(A.isSubsetOf(B)).toBe(A.union(B) === B);
  expect(A.union(A)).toBe(A);
  expect(A.intersection(A)).toBe(A);
  expect(A.difference(A)).toBe(ValueSet.empty());
  expect(A.symmetricDifference(A)).toBe(ValueSet.empty());
  expect(A.union(ValueSet.empty())).toBe(A);
  expect(A.intersection(ValueSet.empty())).toBe(ValueSet.empty());
}

describe('property — set algebra converges on ValueSet.from of the array answer', () => {
  it('integers', () => {
    fc.assert(fc.property(ints, ints, (xs, ys) => checkAll(xs, ys)), { numRuns: 300 });
  });

  it('records', () => {
    fc.assert(fc.property(recs, recs, (xs, ys) => checkAll(xs, ys)), { numRuns: 200 });
  });

  it('mixed primitives and records', () => {
    fc.assert(fc.property(mixed, mixed, (xs, ys) => checkAll(xs, ys)), { numRuns: 200 });
  });

  it('versions: a set against itself with a few edits shares everything but the edits', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 200, maxLength: 800 }),
        fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 5 }),
        (base, added, removed) => {
          const xs = [...new Set(base)];
          const A = ValueSet.from(xs);
          let B = A;
          for (const v of removed) B = B.delete(v);
          for (const v of added) B = B.add(v);
          const ys = [...B];
          checkAll(xs, ys);
          // The differing region is tiny, so the results relate to the inputs by identity.
          expect(A.union(B).size).toBeLessThanOrEqual(xs.length + added.length);
          expect(A.intersection(B).size).toBeGreaterThanOrEqual(xs.length - removed.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('members that are canonical objects behave exactly like primitives', () => {
    const a = ValueSet.from([intern({ k: 1 }), intern({ k: 2 })]);
    const b = ValueSet.from([{ k: 2 }, { k: 3 }]);
    expect(a.union(b)).toBe(ValueSet.from([{ k: 1 }, { k: 2 }, { k: 3 }]));
    expect(a.intersection(b)).toBe(ValueSet.from([{ k: 2 }]));
    expect(a.intersection(b).has({ k: 2 })).toBe(true);
    expect([...a.intersection(b)][0]).toBe(intern({ k: 2 }));
  });
});
