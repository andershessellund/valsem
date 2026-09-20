// ---------------------------------------------------------------------------
// Two values of DIFFERENT SHAPE with the same full hash: an array and a
// longer array, an array and a record, a record and a record with more keys.
//
// No hasher can be made to produce these. A Hasher sees leaves; the shape
// (the kind's tag, the length, the key count) is mixed in after it, so a
// weak or constant leaf hasher collides values of ONE shape with each other
// (collisions.test.ts) and leaves different shapes as far apart as ever.
//
// They are found instead. A hash is 32 bits, so among N values of one shape
// and N of another about N²/2³² pairs coincide: some twenty at N = 300 000,
// a quarter of a second's search through the public `internHash`. The seed
// differs per process, so every run finds different pairs, and finding none
// has odds near e⁻²⁰.
//
// This is not an exotic case kept alive for coverage. A pool of a few million
// values (soak-findings) holds thousands of such pairs, and what keeps each
// of them two values is the comparison the pool makes AFTER the hash
// matched: the length, the key count, the prototype. Nothing else in the
// suite reaches those lines.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll } from 'vitest';
import { intern, internHash, isCanonical } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { produce } from './produce.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';

const N = 300_000;

type Pair = readonly [unknown, unknown];

/** Every (left(i), right(j)) with one hash, for i, j below N. Both are built fresh on each call, never interned by the search. */
function coincidences(left: (i: number) => unknown, right: (j: number) => unknown): (() => Pair)[] {
  const byHash = new Map<number, number>();
  for (let i = 0; i < N; i++) byHash.set(internHash(left(i)), i);
  const found: (() => Pair)[] = [];
  for (let j = 0; j < N; j++) {
    const i = byHash.get(internHash(right(j)));
    if (i !== undefined) found.push(() => [left(i), right(j)]);
  }
  return found;
}

const shapes = {
  'an array and a longer array': coincidences((i) => [i], (j) => [j, 0]),
  'an array and a record with as many keys as it has elements': coincidences((i) => [i], (j) => ({ a: j })),
  'an array and a record with more keys': coincidences((i) => [i], (j) => ({ a: j, b: 0 })),
  'a record and a record with more keys': coincidences((i) => ({ a: i }), (j) => ({ a: j, b: 0 })),
} as const;

describe.each(Object.entries(shapes))('%s, sharing a full hash', (_name, found) => {
  beforeAll(() => {
    // Not a flake to retry: at ~20 expected this is a change in how shape enters the hash.
    expect(found.length, `no coincidence among ${N}² pairs`).toBeGreaterThan(0);
  });

  it('are unequal, and the pool keeps them two values, whichever came first', () => {
    // Alternate which of the pair is pooled first: the comparison that tells
    // them apart is made with the POOLED one as the candidate.
    found.slice(0, 8).forEach((pair, n) => {
      const [x, y] = pair();
      expect(internHash(x)).toBe(internHash(y));
      expect(deepEqual(x, y)).toBe(false);
      expect(deepEqual(y, x)).toBe(false);
      const [first, second] = n % 2 === 0 ? [x, y] : [y, x];
      const a = intern(first);
      const b = intern(second);
      expect(b).not.toBe(a);
      expect(a).toEqual(first);
      expect(b).toEqual(second);
      // Each still converges with its own equals, past the other in the bucket.
      const [x2, y2] = pair();
      expect(intern(x2)).toBe(n % 2 === 0 ? a : b);
      expect(intern(y2)).toBe(n % 2 === 0 ? b : a);
    });
  });

  it('are two members of a set and two keys of a map', () => {
    const [x, y] = found[0]!();
    const s = ValueSet.from([x, y]);
    expect(s.size).toBe(2);
    expect(s.has(found[0]!()[0])).toBe(true);
    expect(s.has(found[0]!()[1])).toBe(true);
    expect(ValueSet.from([y, x])).toBe(s);
    expect(s.delete(x)).toBe(ValueSet.from([y]));
    const m = new HashMap<unknown, string>();
    m.set(x, 'x');
    m.set(y, 'y');
    expect(m.size).toBe(2);
    expect(m.get(found[0]!()[0])).toBe('x');
    expect(m.get(found[0]!()[1])).toBe('y');
  });
});

describe('a recipe whose result shares a hash with a pooled value of another shape', () => {
  // produce looks its result up by a hash it folded incrementally, and makes
  // the same comparison against whatever is pooled under it.
  it('a record result, against a pooled record with more keys and against a pooled array', () => {
    for (const found of [shapes['a record and a record with more keys'], shapes['an array and a record with as many keys as it has elements']]) {
      for (const pair of found.slice(0, 4)) {
        const [p, q] = pair();
        const [small, other] = (Array.isArray(p) ? [q, p] : [p, q]) as [{ a: number }, unknown];
        const pooled = intern(other); // the wider record, or the array: in the pool first
        const result = produce(intern({ a: -1 }), (d) => void (d.a = small.a));
        expect(internHash(result)).toBe(internHash(pooled));
        expect(result).not.toBe(pooled);
        expect(result).toEqual({ a: small.a });
        expect(isCanonical(result)).toBe(true);
        expect(intern({ a: small.a })).toBe(result);
      }
    }
  });

  it('an array result, against a pooled longer array and against a pooled record', () => {
    for (const found of [shapes['an array and a longer array'], shapes['an array and a record with more keys']]) {
      for (const pair of found.slice(0, 4)) {
        const [short, other] = pair() as [number[], unknown];
        const pooled = intern(other);
        const result = produce(intern([-1]), (d) => void (d[0] = short[0]!));
        expect(internHash(result)).toBe(internHash(pooled));
        expect(result).not.toBe(pooled);
        expect(result).toEqual(short);
        expect(intern([short[0]])).toBe(result);
      }
    }
  });
});

// The same arithmetic, where the hash is not one a test can ask for: memoize
// folds its argument list privately, and a list is pooled by a hash of its own. So
// these pairs are not looked for. Enough candidates of two shapes are simply
// alive at once for a dozen or so to coincide, and what is asserted is that
// every one of the half million answers is right, the coinciding ones among
// them. (No guard is possible here. The count is the guarantee: ~15 expected.)
describe('coincidences that are there without being looked for', () => {
  const M = 250_000;

  it('memoize: a call with one argument and a call with two, under one hash, are two calls', () => {
    let calls = 0;
    const f = memoize((a: number, b?: number) => (calls++, b === undefined ? a : -a - 1), { maxSize: Infinity });
    for (let i = 0; i < M; i++) if (f(i) !== i) throw new Error(`f(${i})`);
    for (let i = 0; i < M; i++) if (f(i, 0) !== -i - 1) throw new Error(`f(${i}, 0)`);
    expect(calls).toBe(2 * M);
    expect(f.size).toBe(2 * M);
    for (let i = 0; i < M; i += 997) {
      expect(f(i)).toBe(i);
      expect(f(i, 0)).toBe(-i - 1);
    }
    expect(calls).toBe(2 * M); // all hits
    f.clear(); // half a million entries: let them go before the next test builds its own
  });

  it('ValueList: a one-element list and a two-element list under one hash are two lists', () => {
    // Pooled by a hash of their own, then told apart by their elements: the
    // place where two slot arrays of different LENGTH are compared. (A trie
    // node cannot get there: its bitmaps are compared first, and equal
    // bitmaps mean equally many slots.)
    const ones: ValueList<number>[] = [];
    const twos: ValueList<number>[] = [];
    for (let i = 0; i < M; i++) ones.push(ValueList.of(i));
    for (let i = 0; i < M; i++) twos.push(ValueList.of(i, 0));
    for (let i = 0; i < M; i++) {
      const one = ones[i]!;
      const two = twos[i]!;
      if (one.length !== 1 || one.get(0) !== i || two.length !== 2 || two.get(0) !== i || two.get(1) !== 0) throw new Error(`list ${i}`);
    }
    expect(new Set(ones).size).toBe(M);
    expect(new Set(twos).size).toBe(M);
    expect(ValueList.of(7)).toBe(ones[7]);
    expect(ValueList.of(7, 0)).toBe(twos[7]);
  });
});
