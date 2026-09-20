// ---------------------------------------------------------------------------
// Index arguments at the collection boundary.
//
// Two rounds of history. First: ValueList and RawArray promise Array bounds
// for `slice`/`splice`, but never looked at their arguments, and a fractional
// index walked the tree to a position between elements and built a list of
// `undefined`s, which was then interned as a canonical value (external
// review, finding 6). The fix coerced as Array does, ToIntegerOrInfinity.
// Second (D45): positional arguments are CHECKED, by what they name.
//
//   - an ELEMENT (`get`, `keyAt`, `valueAt`, `set`, `remove`): an
//     integer in [0, length), or a RangeError. No element, no answer;
//   - an INSERTION POINT (`insert`, `insertAt`, `splice`'s start): an integer
//     in [0, length], not counted from the end, or a RangeError. An edit
//     lands in canonical state, so the place must exist, and -1 (an
//     `indexOf` miss) must not mean "the last one";
//   - a RANGE (`slice`'s bounds, `splice`'s count): the oracle is still the
//     plain Array, clamping and all, since a range has an answer wherever it
//     points: the part of it that exists;
//   - a PATCH is exact: an index or count that does not fit is a patch made
//     against another value, and is refused.
//
// A non-integer (NaN, 1.5, '2') is a RangeError in all of them, thrown before
// anything is touched.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { RawArray } from './raw-array.js';
import { OrderedSet } from './ordered-set.js';
import { OrderedMap } from './ordered-map.js';
import { applyPatches, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { indexArg, extentArg, elementIndex, insertionIndex } from './shared.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

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

describe('the three kinds of position', () => {
  it('an extent is an integer ≥ 0, or Infinity for "the rest"', () => {
    for (const ok of [0, 3, 1e9, Infinity]) expect(extentArg(ok, 'op', 'count')).toBe(ok);
    expect(Object.is(extentArg(-0, 'op', 'count'), 0)).toBe(true);
    for (const bad of [-1, -Infinity, NaN, 1.5]) expect(() => extentArg(bad, 'op', 'count')).toThrow(RangeError);
    expect(() => extentArg(-1, 'op', 'count')).toThrow('op: count must not be negative, got -1');
  });

  it('an element index is an integer in [0, length)', () => {
    expect(elementIndex(0, 3, 'op')).toBe(0);
    expect(elementIndex(2, 3, 'op')).toBe(2);
    expect(Object.is(elementIndex(-0, 3, 'op'), 0)).toBe(true);
    for (const bad of [3, -1, 99, Infinity, -Infinity, 0.5, NaN]) expect(() => elementIndex(bad, 3, 'op')).toThrow(RangeError);
    expect(() => elementIndex(0, 0, 'op')).toThrow('op: index 0 out of range [0, 0)');
    expect(() => elementIndex(NaN, 3, 'op')).toThrow('op: index must be an integer, got NaN');
  });

  it('an insertion index is an integer in [0, length]', () => {
    expect(insertionIndex(3, 3, 'op')).toBe(3);
    expect(insertionIndex(0, 0, 'op')).toBe(0);
    for (const bad of [4, -1, Infinity, -Infinity, 0.5, NaN]) expect(() => insertionIndex(bad, 3, 'op')).toThrow(RangeError);
    expect(() => insertionIndex(-1, 3, 'op', 'start')).toThrow('op: start -1 out of range [0, 3]');
  });
});

describe('ValueList: a range is Array’s, for whole arguments', () => {
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

  it('no slice can build a list holding a hole', () => {
    fc.assert(
      fc.property(size, whole, whole, (n, a, b) => {
        const out = ValueList.from(range(n)).slice(a, b);
        expect([...out].every((v) => typeof v === 'number')).toBe(true);
        expect(out.length).toBe([...out].length);
      }),
      { numRuns: 400 },
    );
  });

  it('a non-integer bound throws', () => {
    fc.assert(
      fc.property(size, junk, (n, bad) => {
        const list = ValueList.from(range(n)) as unknown as Record<string, Loose>;
        expect(() => list.slice!(bad)).toThrow(RangeError);
        expect(() => list.slice!(0, bad)).toThrow(RangeError);
      }),
      { numRuns: 300 },
    );
  });
});

describe('ValueList: an edit names a place that exists', () => {
  // A start in [0, n], and how much to remove: a count (clamped: "up to"),
  // Infinity, or nothing at all.
  const count = fc.oneof(fc.constantFrom(0, 1, 3, 1e9, Infinity), fc.integer({ min: 0, max: 400 }));

  it('splice: a start in [0, length] and a count that means "up to" are Array’s splice', () => {
    fc.assert(
      fc.property(size, fc.nat(), count, fc.array(fc.integer(), { maxLength: 3 }), (n, at, del, items) => {
        const start = at % (n + 1);
        const list = ValueList.from(range(n));
        const withCount = range(n);
        withCount.splice(start, del, ...items);
        expect([...list.splice(start, del, ...items)]).toEqual(withCount);
        const toEnd = range(n);
        toEnd.splice(start);
        expect([...list.splice(start)]).toEqual(toEnd);
        expect([...list.splice(start, undefined)]).toEqual(toEnd);
        // The items follow the count as Array takes them, and Array reads an
        // `undefined` count before items as 0: "the rest, and insert" is Infinity.
        expect([...list.splice(start, Infinity, ...items)]).toEqual([...toEnd, ...items]);
        if (items.length !== 0) {
          expect(() => list.splice(start, undefined, ...items)).toThrow(/ValueList\.splice: deleteCount must be an integer when items follow it, got undefined/);
        }
        expect(list.splice(start, del, ...items)).toBe(ValueList.from(withCount)); // and it is the canonical of that content
      }),
      { numRuns: 600 },
    );
  });

  it('splice: a start that is no place in the list throws, as does a negative count', () => {
    fc.assert(
      fc.property(size, fc.integer({ min: 1, max: 400 }), (n, k) => {
        const list = ValueList.from(range(n));
        for (const start of [n + k, -k, Infinity, -Infinity]) {
          expect(() => list.splice(start)).toThrow(RangeError);
          expect(() => list.splice(start, 1)).toThrow(RangeError);
          expect(() => list.splice(start, 0, 9)).toThrow(RangeError);
        }
        expect(() => list.splice(0, -k)).toThrow(RangeError);
      }),
      { numRuns: 200 },
    );
  });

  it('insert takes [0, length]; remove takes an element', () => {
    const list = ValueList.from(range(5));
    expect([...list.insert(0, 9)]).toEqual([9, 0, 1, 2, 3, 4]);
    expect([...list.insert(5, 9)]).toEqual([0, 1, 2, 3, 4, 9]);
    expect([...list.remove(0)]).toEqual([1, 2, 3, 4]);
    expect([...list.remove(4)]).toEqual([0, 1, 2, 3]);
    for (const bad of [6, 99, -1, Infinity]) expect(() => list.insert(bad, 9)).toThrow(RangeError);
    for (const bad of [5, 99, -1, Infinity]) expect(() => list.remove(bad)).toThrow(RangeError);
    // The bug this is for: an indexOf miss is -1, which used to count from
    // the end and delete the last element.
    expect(() => list.remove(list.toArray().indexOf(42))).toThrow('ValueList.remove: index -1 out of range [0, 5)');
    expect(() => list.splice(list.toArray().indexOf(42), 1)).toThrow('ValueList.splice: start -1 out of range [0, 5]');
  });

  it('anything that is not an integer throws, at every edit', () => {
    fc.assert(
      fc.property(size, junk, (n, bad) => {
        const list = ValueList.from(range(n)) as unknown as Record<string, Loose>;
        for (const call of [
          () => list.splice!(bad),
          () => list.splice!(bad, 1),
          () => list.splice!(0, bad),
          () => list.splice!(0, bad, [9]),
          () => list.insert!(bad, 9),
          () => list.remove!(bad),
          () => list.set!(bad, 9),
          () => list.setMany!([[bad, 9]]),
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
});

describe('ValueList: an edit names an element; a read is Array.prototype.at', () => {
  it('set and setMany answer for [0, length) and throw for anything else; at reads what is there, or undefined', () => {
    for (const n of [5, 300]) {
      const list = ValueList.from(range(n));
      for (const i of [NaN, 0.5, 1.5, -1, -0.5, Infinity, -Infinity, n, n + 0.5]) {
        expect(() => list.set(i, 9)).toThrow(RangeError);
        expect(() => list.setMany([[i, 9]])).toThrow(RangeError);
      }
      for (const i of [NaN, 0.5, 1.5, -0.5, n + 0.5]) expect(() => list.at(i)).toThrow(RangeError);
      for (const i of [Infinity, -Infinity, n, -n - 1]) expect(list.at(i)).toBeUndefined();
      expect(list.at(-0)).toBe(0);
      expect(list.at(n - 1)).toBe(n - 1);
      expect(list.at(-1)).toBe(n - 1);
      expect(list.at(-n)).toBe(0);
      expect(list.set(-0, 9).at(0)).toBe(9);
    }
    expect(ValueList.empty().at(0)).toBeUndefined();
    expect(ValueList.empty().at(-1)).toBeUndefined();
  });

  it('the midpoint of an odd list is still a loud mistake: a non-integer is not an index', () => {
    const list = ValueList.from(range(5));
    expect(() => list.at(list.length / 2)).toThrow('ValueList.at: index must be an integer, got 2.5');
    expect(list.at(list.length >> 1)).toBe(2);
  });
});

describe('at is Array.prototype.at, for whole arguments', () => {
  // The one accessor that takes Array's bounds, because it takes Array's name:
  // a negative index counts from the end, and one that names nothing is
  // `undefined`. `get`, `keyAt` and `valueAt` stay the strict ones.
  const whole = fc.oneof(fc.integer({ min: -12, max: 12 }), fc.constantFrom(Infinity, -Infinity, -0));

  it('on ValueList, OrderedSet and OrderedMap, and on their drafts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), whole, (n, i) => {
        const xs = range(n);
        const entries = xs.map((x) => [`k${x}`, x] as [string, number]);
        const list = ValueList.from(xs);
        const set = OrderedSet.from(xs);
        const map = OrderedMap.from(entries);
        expect(list.at(i)).toBe(xs.at(i));
        expect(set.at(i)).toBe(xs.at(i));
        expect(map.at(i)).toEqual(entries.at(i));
        produce({ list, set, map }, (d) => {
          expect(d.list.at(i)).toBe(xs.at(i));
          expect(d.set.at(i)).toBe(xs.at(i));
          expect(d.map.at(i)).toEqual(entries.at(i));
          d.list.push(99); // and over what the recipe has done so far
          expect(d.list.at(-1)).toBe(99);
          expect(d.list.at(i)).toBe([...xs, 99].at(i));
        });
      }),
      { numRuns: 400 },
    );
  });

  it('hands out a draft on a draft, as get does', () => {
    const next = produce({ l: ValueList.of({ v: 1 }, { v: 2 }), m: OrderedMap.from([['a', { v: 1 }]]) }, (d) => {
      expect(d.l.at(-1)).toBe(d.l.at(1));
      d.l.at(-1)!.v = 20;
      d.m.at(-1)![1].v = 10;
      expect(d.l.at(2)).toBeUndefined();
      expect(d.m.at(1)).toBeUndefined();
    });
    expect(next.l).toBe(ValueList.of({ v: 1 }, { v: 20 }));
    expect(next.m).toBe(OrderedMap.from([['a', { v: 10 }]]));
  });

  it('its bounds are Array’s and its type is not: a non-integer throws, as everywhere', () => {
    const list = ValueList.of(1, 2, 3);
    for (const bad of [...JUNK, undefined]) {
      expect(() => (list.at as Loose)(bad)).toThrow(RangeError);
      expect(() => (OrderedSet.of(1).at as Loose)(bad)).toThrow(RangeError);
      expect(() => (OrderedMap.from([['a', 1]]).at as Loose)(bad)).toThrow(RangeError);
    }
    expect(() => (list.at as Loose)(0.5)).toThrow('ValueList.at: index must be an integer, got 0.5');
    expect([1, 2, 3].at(0.5)).toBe(1); // where Array truncates
  });
});

describe('the other index-taking entry points', () => {
  it('RawArray: slice is a range (Array’s, and the window past the last row is the rows there are); at is Array’s too', () => {
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
      expect(() => raw.at!(bad)).toThrow(RangeError);
    }
    expect(raw.slice!()).toEqual([1, 2, 3]); // both optional: the whole content
    expect(raw.slice!(0, 100)).toEqual([1, 2, 3]);
    expect(raw.at!(2)).toBe(3);
    expect(raw.at!(-1)).toBe(3);
    expect(raw.at!(3)).toBeUndefined();
    for (const i of [-4, Infinity, -Infinity]) expect(raw.at!(i)).toBeUndefined();
  });

  it('OrderedSet and OrderedMap: first and last have no index to get wrong; insertAt names a place', () => {
    const s = OrderedSet.from([1, 2, 3]);
    const m = OrderedMap.from([['a', 1], ['b', 2]]);
    expect(OrderedSet.empty().first()).toBeUndefined();
    expect(OrderedSet.empty().last()).toBeUndefined();
    expect(OrderedMap.empty().first()).toBeUndefined();
    expect(OrderedMap.empty().last()).toBeUndefined();
    expect(() => s.insertAt(0.5, 9)).toThrow(RangeError);
    expect(() => s.insertAt(4, 9)).toThrow(RangeError);
    expect(() => m.insertAt(NaN, 'z', 9)).toThrow(RangeError);
    expect(() => m.insertAt(-1, 'z', 9)).toThrow(RangeError);
  });

  it('the ordered drafts: the same, mid-recipe', () => {
    produce({ s: OrderedSet.from([1, 2]), m: OrderedMap.from([['a', { v: 1 }]]) }, (d) => {
      d.s.add(3);
      expect(d.s.at(2)).toBe(3);
      expect(d.m.at(0)![0]).toBe('a');
      d.m.at(0)![1].v = 2;
      for (const i of [NaN, 0.5]) {
        expect(() => d.s.at(i)).toThrow(RangeError);
        expect(() => d.m.at(i)).toThrow(RangeError);
      }
      d.s.clear();
      d.m.clear();
      expect(d.s.first()).toBeUndefined();
      expect(d.s.last()).toBeUndefined();
      expect(d.m.first()).toBeUndefined();
      expect(d.m.last()).toBeUndefined();
    });
  });

  it('DraftList.splice: a start in [0, length] and a count that means "up to" are Array’s splice', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.oneof(fc.constantFrom(0, 1, 1e9, Infinity), fc.nat(12)), (start, del) => {
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

  it('DraftList: anything else is a RangeError, and the draft is untouched', () => {
    const base = ValueList.from(range(8));
    for (const bad of [...JUNK, undefined, 9, -1, Infinity, -Infinity]) {
      let threw: unknown;
      const next = produce(base, (d) => {
        d.push(8); // so there is a tail to leave alone
        d.pop();
        try {
          (d.splice as Loose)(bad, 1, 99);
        } catch (e) {
          threw = e;
        }
      });
      expect(threw).toBeInstanceOf(RangeError);
      expect(next).toBe(base);
    }
    for (const bad of [...JUNK, -1]) {
      expect(() => produce(base, (d) => void (d.splice as Loose)(0, bad, 99))).toThrow(RangeError);
    }
    // An `undefined` count before items: Array reads it as 0, "left out" reads
    // as through the end, so it throws, and the draft is untouched.
    let threw: unknown;
    const kept = produce(base, (d) => {
      try {
        d.splice(2, undefined, 99);
      } catch (e) {
        threw = e;
      }
    });
    expect(threw).toBeInstanceOf(RangeError);
    expect((threw as Error).message).toMatch(/^DraftList\.splice: deleteCount must be an integer when items follow it, got undefined/);
    expect(kept).toBe(base);
    expect([...produce(base, (d) => void d.splice(2, undefined))]).toEqual(range(2)); // with no items it is the default
    produce(base, (d) => {
      d.push(8);
      expect(d.at(8)).toBe(8); // the tail counts
      expect(d.at(-1)).toBe(8);
      expect(d.at(9)).toBeUndefined();
      for (const i of [1.5, NaN]) expect(() => d.at(i)).toThrow(RangeError);
      for (const i of [9, -1, 1.5, NaN]) expect(() => d.set(i, 0)).toThrow(RangeError);
    });
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
        expectPatchRoundTrip(base, result, patches, inverse);
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

// A patch is an exact recorded edit, never "up to". One whose index or count
// does not fit was made against another value: a negative index used to wrap
// on a ValueList, an overshooting count clamped on both kinds, and the stale
// patch applied "successfully" to the wrong base.
describe('applyPatches: sequence patches must fit the value they are applied to', () => {
  const values = { list: intern({ l: ValueList.from(range(3)) }), array: intern({ l: range(3) }) };

  for (const [kind, base] of Object.entries(values)) {
    it(`${kind}: a list.splice fits, or is refused`, () => {
      const at = (index: number, remove: number): unknown =>
        applyPatches(base, [{ kind: 'list.splice', path: ['l'], index, remove, insert: [9] }]);
      expect([...(at(3, 0) as { l: Iterable<number> }).l]).toEqual([0, 1, 2, 9]);
      expect([...(at(1, 2) as { l: Iterable<number> }).l]).toEqual([0, 9]);
      for (const [index, remove] of [[4, 0], [0, 4], [2, 2], [-1, 1], [0, -1], [NaN, 0], [0, 1.5], [0, 1e9]] as const) {
        expect(() => at(index, remove)).toThrow(/does not fit|malformed/);
      }
    });

    it(`${kind}: a list.set names an element, or is refused`, () => {
      const at = (index: number): unknown => applyPatches(base, [{ kind: 'list.set', path: ['l'], index, value: 9 }]);
      expect([...(at(2) as { l: Iterable<number> }).l]).toEqual([0, 1, 9]);
      for (const index of [3, 99, -1, 0.5, NaN]) expect(() => at(index)).toThrow();
    });

    it(`${kind}: a patch made against another base does not apply`, () => {
      const longer = intern({ l: kind === 'list' ? ValueList.from(range(10)) : range(10) });
      const [, patches] = produceWithPatches(longer, (d) => void (d.l as { splice: Loose }).splice(6, 3));
      expect(() => applyPatches(base, patches)).toThrow(/does not fit/);
    });
  }

  it('sequence ops are for sequences, record ops for records', () => {
    const rec = intern({ a: 1 });
    expect(() => applyPatches(rec, [{ kind: 'list.set', path: [], index: 0, value: 2 }])).toThrow(/cannot apply a 'list.set' patch/);
    expect(() => applyPatches(rec, [{ kind: 'list.splice', path: [], index: 0, remove: 0, insert: [7] }])).toThrow(/cannot apply a 'list.splice' patch/);
    expect(() => applyPatches(values.array, [{ kind: 'record.delete', path: ['l'], key: '0' }])).toThrow(/cannot apply a 'record.delete' patch/);
  });

  it('a path segment that names no element is a bad path, on a list as on an array', () => {
    const deep = intern({ l: ValueList.of({ v: 1 }) });
    for (const seg of [1, -1, 0.5, NaN, '0']) {
      expect(() => applyPatches(deep, [{ kind: 'record.set', path: ['l', seg], key: 'v', value: 2 }])).toThrow();
    }
    expect(applyPatches(deep, [{ kind: 'record.set', path: ['l', 0], key: 'v', value: 2 }])).toBe(intern({ l: ValueList.of({ v: 2 }) }));
  });
});
