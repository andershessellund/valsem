// ---------------------------------------------------------------------------
// Index arguments at the collection boundary.
//
// Two rounds of history. First: ValueList and RawArray promise Array bounds
// for `slice`/`splice`, but never looked at their arguments, and a fractional
// index walked the tree to a position between elements and built a list of
// `undefined`s, which was then interned as a canonical value (external
// review, finding 6). The fix coerced as Array does, ToIntegerOrInfinity.
// Second (D45): coercion is the half of Array's rules not worth inheriting.
// A NaN index is an upstream computation gone wrong, and "index 0" is an
// edit nobody chose. So an index argument is CHECKED: an integer or
// ±Infinity, or a RangeError.
//
// The oracle is therefore split. For whole arguments it is the plain Array,
// all of it: negative counts from the end, out of range clamps. For anything
// else it is a RangeError, at every operation that cuts or edits at a
// position, thrown before anything is touched. Reads (`get`, `at`) answer
// `undefined` for what is not an index, as they always did.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { RawArray } from './raw-array.js';
import { OrderedSet } from './ordered-set.js';
import { OrderedMap } from './ordered-map.js';
import { applyPatches, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { indexArg } from './shared.js';

// Whole arguments: integers on both sides of every bound, -0, the infinities.
const WHOLE = [-0, 0, 3, -3, 1e9, -1e9, Infinity, -Infinity] as const;
const whole = fc.oneof(fc.constantFrom(...WHOLE), fc.integer({ min: -400, max: 400 }));
// Everything else a JavaScript caller can put in an index position.
const FRACTIONS = [NaN, 0.5, 1.5, -1.5, -0.5, 2.999] as const;
const NOT_NUMBERS = [null, '2', 'x', '', true, {}, [1], 1n, Symbol('i')] as const;
const JUNK: readonly unknown[] = [...FRACTIONS, ...NOT_NUMBERS];
const junk = fc.oneof(
  fc.constantFrom(...JUNK),
  fc.double({ min: -400, max: 400, noNaN: true }).filter((x) => !Number.isInteger(x)),
);

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
// Sizes on both sides of the list's open tail and its tree.
const size = fc.constantFrom(0, 1, 5, 40, 300);
type Loose = (...args: unknown[]) => unknown;

describe('indexArg accepts a position and nothing else', () => {
  it.each([[7, 7], [-7, -7], [0, 0], [-0, 0], [1e9, 1e9], [Infinity, Infinity], [-Infinity, -Infinity]])(
    '%s → %s',
    (input, expected) => expect(Object.is(indexArg(input, 'op', 'start'), expected)).toBe(true),
  );

  it.each([...JUNK, undefined].map((v) => [v]))('%s throws a RangeError naming the operation and the argument', (input) => {
    expect(() => indexArg(input as number, 'ValueList.splice', 'start')).toThrow(RangeError);
    expect(() => indexArg(input as number, 'ValueList.splice', 'start')).toThrow(/^ValueList\.splice: start must be an integer, got /);
  });

  it('shows the argument without running it or throwing on it', () => {
    const message = (v: unknown): string => {
      try {
        indexArg(v as number, 'op', 'i');
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(message('2')).toBe('op: i must be an integer, got "2"');
    expect(message(1n)).toBe('op: i must be an integer, got 1n');
    expect(message(Object.create(null))).toBe('op: i must be an integer, got an object');
    expect(message(Symbol('s'))).toBe('op: i must be an integer, got Symbol(s)');
    expect(message(() => 1)).toBe('op: i must be an integer, got a function');
  });
});

describe('ValueList: whole index arguments behave as Array’s do', () => {
  it('slice', () => {
    fc.assert(
      fc.property(size, whole, whole, (n, a, b) => {
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
      fc.property(size, whole, whole, fc.array(fc.integer(), { maxLength: 3 }), (n, start, del, items) => {
        const list = ValueList.from(range(n));
        const withCount = range(n);
        withCount.splice(start, del, ...items);
        expect([...list.splice(start, del, items)]).toEqual(withCount);
        const toEnd = range(n);
        toEnd.splice(start);
        expect([...list.splice(start)]).toEqual(toEnd);
        // The items are one array here, so an `undefined` count is how a caller
        // removes through the end AND inserts: it means "omitted", not 0.
        expect([...list.splice(start, undefined, items)]).toEqual([...toEnd, ...items]);
      }),
      { numRuns: 600 },
    );
  });

  it('insert and remove are splices, with its bounds', () => {
    const list = ValueList.from(range(5));
    expect([...list.remove(1)]).toEqual([0, 2, 3, 4]);
    expect([...list.remove(-1)]).toEqual([0, 1, 2, 3]);
    expect([...list.insert(1, 9)]).toEqual([0, 9, 1, 2, 3, 4]);
    expect([...list.insert(Infinity, 9)]).toEqual([0, 1, 2, 3, 4, 9]);
    expect(list.remove(99)).toBe(list);
  });

  it('no operation can build a list holding a hole', () => {
    fc.assert(
      fc.property(size, whole, whole, (n, a, b) => {
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

describe('ValueList: anything else throws, at every operation that takes a position', () => {
  it('slice, splice, insert and remove', () => {
    fc.assert(
      fc.property(size, junk, (n, bad) => {
        const list = ValueList.from(range(n)) as unknown as Record<string, Loose>;
        for (const call of [
          () => list.slice!(bad),
          () => list.slice!(0, bad),
          () => list.splice!(bad),
          () => list.splice!(bad, 1),
          () => list.splice!(0, bad),
          () => list.splice!(0, bad, [9]),
          () => list.insert!(bad, 9),
          () => list.remove!(bad),
        ]) {
          expect(call).toThrow(RangeError);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a start is required: splice() cuts nowhere', () => {
    const list = ValueList.from(range(5)) as unknown as Record<string, Loose>;
    expect(() => list.splice!()).toThrow(/ValueList\.splice: start must be an integer, got undefined/);
    expect(() => list.insert!()).toThrow(/ValueList\.insert: index must be an integer, got undefined/);
    expect(() => list.remove!()).toThrow(/ValueList\.remove: index must be an integer, got undefined/);
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
});

describe('the other index-taking entry points', () => {
  it('RawArray.slice and get', () => {
    fc.assert(
      fc.property(whole, whole, (a, b) => {
        const arr = range(12);
        expect(RawArray.from(arr).slice(a, b)).toEqual(arr.slice(a, b));
        expect(RawArray.from(arr).slice(a)).toEqual(arr.slice(a));
      }),
      { numRuns: 300 },
    );
    const raw = RawArray.from([1, 2, 3]) as unknown as Record<string, Loose>;
    for (const bad of JUNK) {
      expect(() => raw.slice!(bad)).toThrow(RangeError);
      expect(() => raw.slice!(0, bad)).toThrow(RangeError);
    }
    expect(raw.slice!()).toEqual([1, 2, 3]); // both optional: the whole content
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

  it('DraftList.splice, whole arguments', () => {
    fc.assert(
      fc.property(whole, whole, (start, del) => {
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

  it('DraftList.splice, anything else: a RangeError, and the draft is untouched', () => {
    const base = ValueList.from(range(8));
    for (const bad of [...JUNK, undefined]) {
      let threw: unknown;
      const next = produce(base, (d) => {
        try {
          (d.splice as Loose)(bad, 1, 99);
        } catch (e) {
          threw = e;
        }
      });
      expect(threw).toBeInstanceOf(RangeError);
      expect(next).toBe(base);
    }
    for (const bad of JUNK) {
      expect(() => produce(base, (d) => void (d.splice as Loose)(0, bad, 99))).toThrow(RangeError);
    }
  });
});

// A plain array inside a recipe IS an Array, and its reads are the native
// ones. Its mutators are valsem's, because it records their intent: `splice`
// truncated once, a NaN start stayed NaN in the recorded op while the native
// splice underneath coerced it to 0, and the NaN went out in the patches,
// which `applyPatches` rejects as malformed.
describe('a plain-array draft’s mutators', () => {
  // Every argument-list shape that has a start.
  const call: fc.Arbitrary<readonly unknown[]> = fc.oneof(
    fc.tuple(whole),
    fc.tuple(whole, whole),
    fc.tuple(whole, whole, fc.integer()),
    fc.tuple(whole, whole, fc.integer(), fc.integer()),
  );
  // Either side of the size where produce copies a frozen base differently.
  const len = fc.constantFrom(0, 1, 5, 80);

  it('splice with whole arguments: the result and the removed elements are Array’s', () => {
    fc.assert(
      fc.property(len, call, (n, args) => {
        const expected = range(n);
        const removed = (expected.splice as Loose)(...args);
        let got: unknown;
        const next = produce(range(n), (d) => void (got = (d.splice as Loose)(...args)));
        expect(next).toEqual(expected);
        expect(got).toEqual(removed);
      }),
      { numRuns: 600 },
    );
  });

  it('and the patches it emits are well-formed and apply in both directions', () => {
    fc.assert(
      fc.property(len, call, (n, args) => {
        const base = intern(range(n));
        const [result, patches, inverse] = produceWithPatches(base, (d) => void (d.splice as Loose)(...args));
        for (const p of [...patches, ...inverse]) {
          if (p.kind !== 'list.splice') continue;
          expect(Number.isInteger(p.index) && !Object.is(p.index, -0)).toBe(true);
          expect(Number.isInteger(p.remove)).toBe(true);
        }
        expect(applyPatches(base, patches)).toBe(result);
        expect(applyPatches(result, inverse)).toBe(base);
      }),
      { numRuns: 600 },
    );
  });

  it.each<[string, readonly unknown[]]>([
    ['no start', []],
    ['a NaN start', [NaN, 1]],
    ['a NaN start alone', [NaN]],
    ['a fractional start', [1.5, 1]],
    ['a string start', ['1', 1]],
    ['an undefined start', [undefined, 1]],
    ['a NaN count', [1, NaN, 9]],
    ['a fractional count', [1, 1.5]],
    // Array reads this one as "remove nothing" (the count is coerced to 0),
    // the ValueList twin as "through the end". A count that is passed is a count.
    ['an explicit undefined count', [1, undefined, 9]],
    ['an explicit undefined count and no items', [1, undefined]],
  ])('splice with %s throws a RangeError', (_, args) => {
    expect(() => produce(range(5), (d) => void (d.splice as Loose)(...args))).toThrow(RangeError);
    expect(() => produce(range(5), (d) => void (d.splice as Loose)(...args))).toThrow(/^valsem: splice on an array draft: /);
  });

  it('fill and copyWithin: whole arguments are Array’s, an undefined one is the default, anything else throws', () => {
    fc.assert(
      fc.property(len, fc.constantFrom<'fill' | 'copyWithin'>('fill', 'copyWithin'), fc.option(whole, { nil: undefined }), fc.option(whole, { nil: undefined }), (n, method, a, b) => {
        const args = method === 'fill' ? [7, a, b] : [1, a, b];
        const expected = range(n);
        (expected[method] as Loose)(...args);
        expect(produce(range(n), (d) => void (d[method] as Loose)(...args))).toEqual(expected);
      }),
      { numRuns: 400 },
    );
    for (const bad of JUNK) {
      expect(() => produce(range(5), (d) => void (d.fill as Loose)(7, bad))).toThrow(RangeError);
      expect(() => produce(range(5), (d) => void (d.fill as Loose)(7, 0, bad))).toThrow(RangeError);
      expect(() => produce(range(5), (d) => void (d.copyWithin as Loose)(bad, 1))).toThrow(RangeError);
      expect(() => produce(range(5), (d) => void (d.copyWithin as Loose)(0, bad))).toThrow(RangeError);
      expect(() => produce(range(5), (d) => void (d.copyWithin as Loose)(0, 1, bad))).toThrow(RangeError);
    }
    expect(() => produce(range(5), (d) => void (d.copyWithin as Loose)())).toThrow(/copyWithin on an array draft: target must be an integer/);
  });

  it('the check runs before the draft is marked or copied', () => {
    const base = intern(range(5));
    // Caught: the draft is as if the call never happened...
    const [same, patches] = produceWithPatches(base, (d) => {
      try {
        d.splice(NaN, 1);
      } catch {
        /* the recipe carries on */
      }
    });
    expect(same).toBe(base);
    expect(patches).toEqual([]);
    // ...including for the mutate-OR-return rule: nothing was mutated.
    const replaced = produce(base as readonly number[], (d) => {
      try {
        d.fill(7, 0.5);
      } catch {
        /* the recipe carries on */
      }
      return [9];
    });
    expect(replaced).toEqual([9]);
  });

  it('reads stay Array’s own, coercion and all', () => {
    produce(range(5), (d) => {
      expect(d.at(NaN)).toBe(0);
      expect(d.slice(1.7)).toEqual([1, 2, 3, 4]);
      expect(d.indexOf(3, NaN)).toBe(3);
      expect(d.includes(0, 0.5)).toBe(true);
    });
  });
});
