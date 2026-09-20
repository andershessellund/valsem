// map, filter, reduce, some, every, find, findIndex: Array's, on ValueList and
// (without the positional two) on the sets, and on their drafts, where they do
// not draft: callbacks see values, results are values, and DraftList.find is
// the one that hands out a draft, the hit.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { produce, isDraft } from './produce.js';
import { intern, isCanonical } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueSet } from './value-set.js';
import { OrderedSet } from './ordered-set.js';

describe('ValueList: the functional reads are Array’s', () => {
  it('agree with Array over any list, and what they build is canonical', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 300 }), fc.integer({ min: -50, max: 50 }), (xs, k) => {
        const list = ValueList.from(xs);
        expect(list.map((x, i) => x * 2 + i)).toBe(ValueList.from(xs.map((x, i) => x * 2 + i)));
        expect(list.filter((x, i) => x > k || i === 0)).toBe(ValueList.from(xs.filter((x, i) => x > k || i === 0)));
        expect(list.reduce((acc, x, i) => acc + x * i, 7)).toBe(xs.reduce((acc, x, i) => acc + x * i, 7));
        expect(list.some((x) => x === k)).toBe(xs.some((x) => x === k));
        expect(list.every((x) => x !== k)).toBe(xs.every((x) => x !== k));
        expect(list.find((x) => x > k)).toBe(xs.find((x) => x > k));
        expect(list.findIndex((x, i) => x > k && i > 2)).toBe(xs.findIndex((x, i) => x > k && i > 2));
        if (xs.length > 0) expect(list.reduce((a, b) => a - b)).toBe(xs.reduce((a, b) => a - b));
      }),
      { numRuns: 200 },
    );
  });

  it('callbacks get (value, index, list) and the thisArg; scans stop at the answer', () => {
    const list = ValueList.of('a', 'b', 'c');
    const self = {};
    const calls: unknown[][] = [];
    list.findIndex(function (this: unknown, v, i, l) {
      calls.push([this, v, i, l]);
      return v === 'b';
    }, self);
    expect(calls).toEqual([[self, 'a', 0, list], [self, 'b', 1, list]]);
    let n = 0;
    expect(list.some(() => ++n === 1)).toBe(true);
    expect(list.every(() => ++n === 0)).toBe(false);
    expect(n).toBe(2);
  });

  it('filter that keeps everything is the list; map interns what it is given', () => {
    const list = ValueList.of({ id: 1 }, { id: 2 });
    expect(list.filter(() => true)).toBe(list);
    const mapped = list.map((t) => ({ ...t, done: false }));
    expect(isCanonical(mapped.get(0))).toBe(true);
    expect(mapped.get(0)).toBe(intern({ id: 1, done: false }));
  });

  it('reduce: an initial value that is passed is one, undefined included; none, on an empty list, throws', () => {
    expect(() => ValueList.empty<number>().reduce((a, b) => a + b)).toThrow(TypeError);
    expect(() => ValueList.empty<number>().reduce((a, b) => a + b)).toThrow('ValueList.reduce: reduce of an empty collection with no initial value');
    expect(ValueList.empty<number>().reduce((a, b) => a + b, 0)).toBe(0);
    const seen: unknown[] = [];
    ValueList.of(1).reduce<undefined>((acc, x) => void seen.push([acc, x]), undefined);
    expect(seen).toEqual([[undefined, 1]]);
    expect(ValueList.of(5).reduce((a, b) => a + b)).toBe(5);
  });

  it('find narrows with a type guard', () => {
    const list = ValueList.of<string | number>('a', 1);
    const n: number | undefined = list.find((x): x is number => typeof x === 'number');
    const ns: ValueList<number> = list.filter((x): x is number => typeof x === 'number');
    expect(n).toBe(1);
    expect(ns).toBe(ValueList.of(1));
  });
});

// One body for both sets. TypeScript cannot call an overloaded method (`filter`)
// on a union of the two classes, so the table types both as the first.
describe.each([
  ['ValueSet', <T,>(xs: T[]) => ValueSet.from(xs)],
  ['OrderedSet', <T,>(xs: T[]) => OrderedSet.from(xs) as unknown as ValueSet<T>],
] as const)('%s: map, filter, reduce, some, every', (_, from) => {
  it('agree with the same read of the members, and build canonical sets', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -20, max: 20 }), { maxLength: 80 }), fc.integer({ min: -20, max: 20 }), (xs, k) => {
        const set = from(xs);
        const members = [...set];
        expect(set.map((x) => Math.abs(x))).toBe(from(members.map((x) => Math.abs(x)))); // equal results are one member
        expect(set.filter((x) => x > k)).toBe(from(members.filter((x) => x > k)));
        expect(set.reduce((acc, x) => acc + x, 3)).toBe(members.reduce((acc, x) => acc + x, 3));
        expect(set.some((x) => x === k)).toBe(members.includes(k));
        expect(set.every((x) => x !== k)).toBe(!members.includes(k));
        expect(set.filter(() => true)).toBe(set);
      }),
      { numRuns: 150 },
    );
  });

  it('callbacks get what forEach passes: (value, value, set)', () => {
    const set = from(['a']);
    const self = {};
    const viaForEach: unknown[][] = [];
    set.forEach(function (this: unknown, ...args) { viaForEach.push([this, ...args]); }, self);
    const viaMap: unknown[][] = [];
    set.map(function (this: unknown, ...args) { viaMap.push([this, ...args]); return 0; }, self);
    expect(viaMap).toEqual(viaForEach);
    expect(viaMap).toEqual([[self, 'a', 'a', set]]);
  });
});

describe('OrderedSet.map keeps the order of first results', () => {
  it('as OrderedSet.from does', () => {
    expect([...OrderedSet.of(3, -3, 1, -1, 2).map((x) => Math.abs(x))]).toEqual([3, 1, 2]);
    expect([...OrderedSet.of(3, 1, 2).filter((x) => x !== 1)]).toEqual([3, 2]);
  });
});

describe('on a draft the functional reads do not draft', () => {
  type Todo = { id: number; done: boolean };
  const todos = (n: number): Todo[] => Array.from({ length: n }, (_, id) => ({ id, done: false }));
  const base = intern({ todos: ValueList.from(todos(50)), tags: ValueSet.from(['a', 'b']), order: OrderedSet.of(3, 1, 2) });

  it('callbacks see values, as they are right now, and the draft as the third argument', () => {
    const next = produce(base, (d) => {
      d.todos.get(7).done = true; // a drafted, edited child
      d.todos.push({ id: 50, done: true });
      const self = {};
      const seen: unknown[] = [];
      const ids = d.todos.map(function (this: unknown, t, i, list) {
        expect(this).toBe(self);
        expect(isDraft(t)).toBe(false);
        expect(list).toBe(d.todos);
        expect(t.id).toBe(i);
        seen.push(t);
        return t.id;
      }, self);
      expect(ids).toBe(ValueList.from(todos(51).map((t) => t.id)));
      expect(seen[7]).toBe(intern({ id: 7, done: true }));
      expect(seen[8]).toBe(base.todos.get(8));
      expect(d.todos.filter((t) => t.done)).toBe(ValueList.of({ id: 7, done: true }, { id: 50, done: true }));
      expect(d.todos.reduce((n, t) => n + (t.done ? 1 : 0), 0)).toBe(2);
      expect(d.todos.some((t, _, list) => list === d.todos && !isDraft(t) && t.done)).toBe(true);
      expect(d.todos.every((t) => !isDraft(t))).toBe(true);
      expect(d.todos.findIndex((t) => t.done)).toBe(7);
      expect(d.todos.findIndex((t) => t.id === 999)).toBe(-1);
    });
    expect(next.todos.length).toBe(51);
  });

  it('reads alone leave the base', () => {
    expect(
      produce(base, (d) => {
        d.todos.map((t) => t.id);
        d.todos.filter((t) => t.done);
        d.todos.reduce((n, t) => n + t.id, 0);
        d.todos.some((t) => t.done);
        d.todos.every((t) => t.done);
        d.todos.findIndex((t) => t.done);
        d.todos.find((t) => t.id === 3); // drafts one element, edits nothing
        d.tags.map((t) => t + t);
        d.order.filter((x) => x > 1);
      }),
    ).toBe(base);
  });

  it('find hands out the hit as get would, so it can be edited through; a miss is undefined', () => {
    const next = produce(base, (d) => {
      const hit = d.todos.find((t, i) => { expect(isDraft(t)).toBe(false); return t.id === 9 && i === 9; })!;
      expect(isDraft(hit)).toBe(true);
      expect(hit).toBe(d.todos.get(9));
      hit.done = true;
      expect(d.todos.find((t) => t.id === -1)).toBeUndefined();
      expect(d.todos.find((t) => t.done)).toBe(hit); // the predicate sees the edit
    });
    expect(next.todos.get(9)).toBe(intern({ id: 9, done: true }));
    expect(next.todos.get(8)).toBe(base.todos.get(8));
  });

  it('the set drafts answer about the set as it is right now, with values', () => {
    produce(base, (d) => {
      d.tags.add('c');
      d.tags.delete('a');
      expect(d.tags.map((t) => t.toUpperCase())).toBe(ValueSet.from(['B', 'C']));
      expect(d.tags.filter((t) => t !== 'b')).toBe(ValueSet.from(['c']));
      expect(d.tags.reduce((n, t) => n + t.length, 0)).toBe(2);
      expect(d.tags.some((t, t2, set) => t === 'c' && t2 === 'c' && set === d.tags)).toBe(true);
      expect(d.tags.every((t) => t !== 'a')).toBe(true);
      d.order.insertAt(0, 9);
      expect([...d.order.map((x) => x % 2)]).toEqual([1, 0]);
      expect(d.order.filter((x) => x > 2)).toBe(OrderedSet.of(9, 3));
      expect(d.order.reduce((acc, x) => acc + x, '')).toBe('9312');
      expect(d.order.some((x) => x === 9)).toBe(true);
      expect(d.order.every((x) => x < 9)).toBe(false);
    });
  });
});
