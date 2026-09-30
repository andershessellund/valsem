// ---------------------------------------------------------------------------
// D59: a value's edits are named for their result, the draft's for what they
// do. The value has `with`, `pushed`, `popped`, `shifted`, `unshifted`,
// `inserted`, `removed`, `toSpliced`, `added`, `deleted` and `insertedAt`;
// the draft has `set`, `push`, `pop`, `shift`, `unshift`, `insert`, `remove`,
// `splice`, `add`, `delete` and `insertAt`. Each pair is one edit: the
// value's method gives what the draft's verb leaves behind. That is the law
// here, pair by pair.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce } from './produce.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueSet } from './value-set.js';
import { ValueMap } from './value-map.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';

describe('ValueList: the copying edit gives what the draft’s verb leaves behind', () => {
  const list = ValueList.of('a', 'b', 'c');
  it.each([
    ['with / set', list.with(1, 'x'), produce(list, (d) => void d.set(1, 'x'))],
    ['pushed / push', list.pushed('d', 'e'), produce(list, (d) => void d.push('d', 'e'))],
    ['popped / pop', list.popped(), produce(list, (d) => void d.pop())],
    ['shifted / shift', list.shifted(), produce(list, (d) => void d.shift())],
    ['unshifted / unshift', list.unshifted('y', 'z'), produce(list, (d) => void d.unshift('y', 'z'))],
    ['inserted / insert', list.inserted(1, 'x'), produce(list, (d) => void d.insert(1, 'x'))],
    ['removed / remove', list.removed(1), produce(list, (d) => void d.remove(1))],
    ['toSpliced / splice', list.toSpliced(1, 1, 'x', 'y'), produce(list, (d) => void d.splice(1, 1, 'x', 'y'))],
    ['toSpliced(start) / splice(start)', list.toSpliced(1), produce(list, (d) => void d.splice(1))],
  ])('%s', (_, byValue, byDraft) => {
    expect(byValue).toBe(byDraft); // canonical, so one instance
    expect(byValue).not.toBe(list);
  });

  it('names the result: popped and shifted are lists, last and first the elements they leave out', () => {
    expect(list.popped()).toBe(ValueList.of('a', 'b'));
    expect(list.last()).toBe('c');
    expect(list.shifted()).toBe(ValueList.of('b', 'c'));
    expect(list.first()).toBe('a');
    const empty = ValueList.empty<string>();
    expect(empty.popped()).toBe(empty);
    expect(empty.shifted()).toBe(empty);
    expect(empty.first()).toBeUndefined();
    expect(empty.last()).toBeUndefined();
    expect(list.pushed()).toBe(list);
    expect(list.unshifted()).toBe(list);
  });

  it('checks its positions in the value’s name (D45)', () => {
    expect(() => list.with(3, 'x')).toThrow('ValueList.with: index 3 out of range [0, 3)');
    expect(() => list.removed(-1)).toThrow('ValueList.removed: index -1 out of range [0, 3)');
    expect(() => list.inserted(4, 'x')).toThrow('ValueList.inserted: index 4 out of range [0, 3]');
    expect(() => list.toSpliced(-1, 1)).toThrow('ValueList.toSpliced: start -1 out of range [0, 3]');
    expect(() => list.toSpliced(0, undefined, 'x')).toThrow('ValueList.toSpliced: deleteCount must be an integer when items follow it');
  });
});

describe('the keyed collections', () => {
  it('ValueMap: with and deleted', () => {
    const m = ValueMap.from([['a', 1]]);
    expect(m.with('b', 2)).toBe(produce(m, (d) => void d.set('b', 2)));
    expect(m.with('a', 9)).toBe(produce(m, (d) => void d.set('a', 9)));
    expect(m.deleted('a')).toBe(produce(m, (d) => void d.delete('a')));
    expect(m.with('a', 1)).toBe(m);
    expect(m.deleted('zz')).toBe(m);
  });

  it('ValueSet: added and deleted', () => {
    const s = ValueSet.of(1, 2);
    expect(s.added(3)).toBe(produce(s, (d) => void d.add(3)));
    expect(s.deleted(1)).toBe(produce(s, (d) => void d.delete(1)));
    expect(s.added(1)).toBe(s);
    expect(s.deleted(7)).toBe(s);
  });

  it('OrderedSet: added, deleted and insertedAt', () => {
    const s = OrderedSet.of('p', 'q');
    expect(s.added('r')).toBe(produce(s, (d) => void d.add('r')));
    expect(s.deleted('p')).toBe(produce(s, (d) => void d.delete('p')));
    expect(s.insertedAt(1, 'x')).toBe(produce(s, (d) => void d.insertAt(1, 'x')));
    expect(s.added('p')).toBe(s);
    expect(() => s.insertedAt(0, 'p')).toThrow('OrderedSet.insertedAt: the value is already a member — a member has one position; remove it first to move it');
    expect(() => s.insertedAt(3, 'z')).toThrow('OrderedSet.insertedAt: index 3 out of range [0, 2]');
  });

  it('OrderedMap: with, deleted and insertedAt', () => {
    const m = OrderedMap.from([['a', 1], ['b', 2]]);
    expect(m.with('c', 3)).toBe(produce(m, (d) => void d.set('c', 3)));
    expect(m.with('a', 9)).toBe(produce(m, (d) => void d.set('a', 9)));
    expect(m.deleted('a')).toBe(produce(m, (d) => void d.delete('a')));
    expect(m.insertedAt(1, 'x', 0)).toBe(produce(m, (d) => void d.insertAt(1, 'x', 0)));
    expect(m.with('a', 1)).toBe(m);
    expect(() => m.insertedAt(0, 'a', 0)).toThrow('OrderedMap.insertedAt: the key is already present — a key has one position; remove it first to move it');
    expect(() => m.insertedAt(3, 'z', 0)).toThrow('OrderedMap.insertedAt: index 3 out of range [0, 2]');
  });
});

describe('first and last', () => {
  it('on a ValueList are at(0) and at(-1)', () => {
    const l = ValueList.of({ id: 1 }, { id: 2 });
    expect(l.first()).toBe(l.at(0));
    expect(l.last()).toBe(l.at(-1));
    expect(l.last()).toEqual({ id: 2 });
  });

  it('on a DraftList hand out drafts, so the element can be edited through them', () => {
    const base = intern({ l: ValueList.of({ id: 1, done: false }, { id: 2, done: false }) });
    const next = produce(base, (d) => {
      d.l.last()!.done = true;
      expect(d.l.first()).toBe(d.l.at(0));
      expect(d.l.last()).toBe(d.l.get(1));
    });
    expect(next.l).toBe(ValueList.of({ id: 1, done: false }, { id: 2, done: true }));
    const empty = intern({ l: ValueList.empty<number>() });
    expect(produce(empty, (d) => void expect([d.l.first(), d.l.last()]).toEqual([undefined, undefined]))).toBe(empty);
  });
});

describe('a what-if on a draft', () => {
  it('on an untouched draft answers as the base would, and touches nothing', () => {
    const base = intern({ l: ValueList.of(1, 2), s: ValueSet.of(1), m: ValueMap.from([['a', 1]]) });
    expect(
      produce(base, (d) => {
        expect(d.l.pushed(3)).toBe(base.l.pushed(3));
        expect(d.l.popped()).toBe(base.l.popped());
        expect(d.l.shifted()).toBe(base.l.shifted());
        expect(d.s.added(2)).toBe(base.s.added(2));
        expect(d.m.deleted('a')).toBe(base.m.deleted('a'));
      }),
    ).toBe(base);
  });

  it('takes a draft argument as the value it holds right now: a later edit through the draft does not reach the what-if', () => {
    const base = intern({ l: ValueList.of({ n: 1 }), extra: { n: 9 } });
    const next = produce(base, (d) => {
      const what = d.l.pushed(d.extra);
      expect(what).toBe(ValueList.of({ n: 1 }, { n: 9 }));
      d.extra.n = 10;
      expect(what).toBe(ValueList.of({ n: 1 }, { n: 9 })); // a value, fixed at the call
    });
    expect(next.extra).toEqual({ n: 10 });
    expect(next.l).toBe(base.l);
  });

  it('takes a collection draft argument the same way, as the value it holds right now', () => {
    const base = intern({ l: ValueList.of<unknown>(1), sub: ValueList.of(2) });
    const next = produce(base, (d) => {
      d.sub.push(3);
      expect(d.l.pushed(d.sub)).toBe(ValueList.of<unknown>(1, ValueList.of(2, 3)));
      d.sub.push(4);
      expect(d.l.pushed(d.sub)).toBe(ValueList.of<unknown>(1, ValueList.of(2, 3, 4)));
    });
    expect(next.sub).toBe(ValueList.of(2, 3, 4));
    expect(next.l).toBe(base.l);
  });
});
