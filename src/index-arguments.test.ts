// ---------------------------------------------------------------------------
// Index arguments at the collection boundary.
//
// ValueList and RawArray promise Array bounds for `slice`/`splice`, but never
// coerced their arguments: a fractional index walked the tree to a position
// between elements and built a list of `undefined`s, which was then interned
// as a canonical value (external review, finding 6). The oracle here is the
// plain Array, for every argument JavaScript callers can produce.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { RawArray } from './raw-array.js';
import { OrderedSet } from './ordered-set.js';
import { OrderedMap } from './ordered-map.js';
import { applyPatches, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { toInteger } from './shared.js';

const ODD = [NaN, 0.5, 1.5, -1.5, -0, -0.5, 2.999, Infinity, -Infinity, 1e9, -1e9, 3, -3, 0] as const;
const odd = fc.oneof(fc.constantFrom(...ODD), fc.integer({ min: -400, max: 400 }), fc.double({ min: -400, max: 400, noNaN: true }));
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
// Sizes on both sides of the list's open tail and its tree.
const size = fc.constantFrom(0, 1, 5, 40, 300);

describe('toInteger is ToIntegerOrInfinity', () => {
  it.each([[NaN, 0], [undefined as unknown as number, 0], [1.9, 1], [-1.9, -1], [-0, 0], [-0.5, 0], [Infinity, Infinity], [-Infinity, -Infinity], [7, 7]])(
    '%s → %s',
    (input, expected) => expect(Object.is(toInteger(input), expected)).toBe(true),
  );
});

describe('ValueList index arguments behave as Array’s do', () => {
  it('slice', () => {
    fc.assert(
      fc.property(size, odd, odd, (n, a, b) => {
        const arr = range(n);
        const list = ValueList.from(arr);
        expect([...list.slice(a, b)]).toEqual(arr.slice(a, b));
        expect([...list.slice(a)]).toEqual(arr.slice(a));
        expect(list.slice(a, b)).toBe(ValueList.from(arr.slice(a, b))); // and it is the canonical of that content
      }),
      { numRuns: 600 },
    );
  });

  it('splice, with and without a deleteCount', () => {
    fc.assert(
      fc.property(size, odd, odd, fc.array(fc.integer(), { maxLength: 3 }), (n, start, del, items) => {
        const list = ValueList.from(range(n));
        const withCount = range(n);
        withCount.splice(start, del, ...items);
        expect([...list.splice(start, del, items)]).toEqual(withCount);
        const toEnd = range(n);
        toEnd.splice(start);
        expect([...list.splice(start)]).toEqual(toEnd);
        // JavaScript callers can pass undefined explicitly; it means "to the end" too.
        expect([...list.splice(start, undefined, items)]).toEqual([...toEnd, ...items]);
      }),
      { numRuns: 600 },
    );
  });

  it('insert and remove are splices', () => {
    const list = ValueList.from(range(5));
    expect([...list.remove(1.5)]).toEqual([0, 2, 3, 4]);
    expect([...list.insert(1.5, 9)]).toEqual([0, 9, 1, 2, 3, 4]);
    expect([...list.remove(NaN)]).toEqual([1, 2, 3, 4]);
  });

  it('get answers undefined for anything that is not an index; set and setMany throw', () => {
    for (const n of [5, 300]) {
      const list = ValueList.from(range(n));
      for (const i of [NaN, 0.5, 1.5, -1, -0.5, Infinity, -Infinity, n, n + 0.5]) {
        expect(list.get(i)).toBeUndefined();
        expect(() => list.set(i, 9)).toThrow(RangeError);
        expect(() => list.setMany([[i, 9]])).toThrow(RangeError);
      }
      expect(list.get(-0)).toBe(0);
      expect(list.set(-0, 9).get(0)).toBe(9);
    }
  });

  it('no operation can build a list holding a hole', () => {
    fc.assert(
      fc.property(size, odd, odd, (n, a, b) => {
        const list = ValueList.from(range(n));
        for (const out of [list.slice(a, b), list.splice(a, b), list.splice(a)]) {
          expect([...out].every((v) => typeof v === 'number')).toBe(true);
          expect(out.length).toBe([...out].length);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('the other index-taking entry points', () => {
  it('RawArray.slice and get', () => {
    fc.assert(
      fc.property(odd, odd, (a, b) => {
        const arr = range(12);
        expect(RawArray.from(arr).slice(a, b)).toEqual(arr.slice(a, b));
        expect(RawArray.from(arr).slice(a)).toEqual(arr.slice(a));
      }),
      { numRuns: 300 },
    );
    expect(RawArray.from([1, 2, 3]).get(0.5)).toBeUndefined();
    expect(RawArray.from([1, 2, 3]).get(NaN)).toBeUndefined();
  });

  it('OrderedSet.at and OrderedMap.at', () => {
    const s = OrderedSet.from([1, 2, 3]);
    const m = OrderedMap.from([['a', 1], ['b', 2]]);
    for (const i of [NaN, 0.5, -1, Infinity, 3.5]) {
      expect(s.at(i)).toBeUndefined();
      expect(m.at(i)).toBeUndefined();
    }
    expect(s.at(1)).toBe(2);
    expect(m.at(1)).toEqual(['b', 2]);
    expect(() => s.insertAt(0.5, 9)).toThrow(RangeError);
    expect(() => m.insertAt(NaN, 'z', 9)).toThrow(RangeError);
  });

  it('DraftList.splice', () => {
    fc.assert(
      fc.property(odd, odd, (start, del) => {
        const expected = range(8);
        const removed = expected.splice(start, del, 99);
        let got: unknown[] = [];
        const next = produce(ValueList.from(range(8)), (d) => void (got = d.splice(start, del, 99)));
        expect([...next]).toEqual(expected);
        expect(got).toEqual(removed);
      }),
      { numRuns: 300 },
    );
  });
});

// A plain array inside a recipe IS an Array, so its `splice` answers to the
// same oracle. It was the one index-taking entry point the suites above left
// out, and it truncated instead of coercing: a NaN start stayed NaN. The
// native splice underneath then coerced it on its own, so the edit happened
// at index 0 while the recorded intent said index NaN, and the NaN went out
// in the patches, which `applyPatches` rejects as malformed.
describe('a plain-array draft’s splice reads its arguments as Array’s does', () => {
  type Splice = (...args: unknown[]) => unknown[];
  // What a JavaScript caller can put in an index position, numbers and not.
  const loose = fc.oneof(odd, fc.constantFrom(undefined, null, '2', '-1', 'x', true));
  // Every argument-list shape: the delete count depends on how many arguments
  // were PASSED (none: remove nothing; a start alone: through the end), not
  // on their values (an explicit `undefined` count is 0).
  const call: fc.Arbitrary<readonly unknown[]> = fc.oneof(
    fc.constant([]),
    fc.tuple(loose),
    fc.tuple(loose, loose),
    fc.tuple(loose, loose, fc.integer()),
    fc.tuple(loose, loose, fc.integer(), fc.integer()),
  );
  // Either side of the size where produce copies a frozen base differently.
  const len = fc.constantFrom(0, 1, 5, 80);

  it('the result and the removed elements match, for every argument list', () => {
    fc.assert(
      fc.property(len, call, (n, args) => {
        const expected = range(n);
        const removed = (expected.splice as Splice)(...args);
        let got: unknown[] = [];
        const next = produce(range(n), (d) => void (got = (d.splice as Splice)(...args)));
        expect(next).toEqual(expected);
        expect(got).toEqual(removed);
      }),
      { numRuns: 600 },
    );
  });

  it('the patches it emits are well-formed and apply in both directions', () => {
    fc.assert(
      fc.property(len, call, (n, args) => {
        const base = intern(range(n));
        const [result, patches, inverse] = produceWithPatches(base, (d) => void (d.splice as Splice)(...args));
        for (const p of [...patches, ...inverse]) {
          if (p.kind !== 'list.splice') continue;
          expect(Number.isInteger(p.index)).toBe(true);
          expect(Number.isInteger(p.remove)).toBe(true);
        }
        expect(applyPatches(base, patches)).toBe(result);
        expect(applyPatches(result, inverse)).toBe(base);
      }),
      { numRuns: 600 },
    );
  });

  it.each<[string, readonly unknown[], number[]]>([
    ['no arguments remove nothing', [], [0, 1, 2, 3, 4]],
    ['a NaN start is 0', [NaN, 1], [1, 2, 3, 4]],
    ['a NaN start alone removes everything', [NaN], []],
    ['a NaN start with an insertion', [NaN, 1, 9], [9, 1, 2, 3, 4]],
    ['an explicit undefined count is 0', [1, undefined, 9], [0, 9, 1, 2, 3, 4]],
    ['a NaN count is 0', [1, NaN, 9], [0, 9, 1, 2, 3, 4]],
  ])('%s', (_, args, expected) => {
    const base = intern(range(5));
    const [result, patches, inverse] = produceWithPatches(base, (d) => void (d.splice as Splice)(...args));
    expect(result).toEqual(expected);
    expect(applyPatches(base, patches)).toBe(result);
    expect(applyPatches(result, inverse)).toBe(base);
  });
});
