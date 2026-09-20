// Iterating a draft collection hands out drafts, as `get` does: a loop in a
// recipe is there to edit. Keys and set members stay values. This file does
// not import `current`, on purpose: the draft reads that go through the
// snapshot (toArray, slice) must work in a bundle that dropped that module.
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, isDraft, castDraft } from './produce.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { OrderedMap } from './ordered-map.js';
import { ValueSet } from './value-set.js';
import { OrderedSet } from './ordered-set.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

type Todo = { id: number; done: boolean };
const todos = (n: number): Todo[] => Array.from({ length: n }, (_, id) => ({ id, done: false }));

describe('DraftList iteration', () => {
  const base = intern({ todos: ValueList.from(todos(200)) });
  const allDone = intern({ todos: ValueList.from(todos(200).map((t) => ({ ...t, done: true }))) });

  it('for…of and forEach hand out drafts, and editing them edits the list', () => {
    expect(produce(base, (d) => { for (const t of d.todos) t.done = true; })).toBe(allDone);
    expect(produce(base, (d) => { d.todos.forEach((t) => { t.done = true; }); })).toBe(allDone);
    produce(base, (d) => {
      const seen: number[] = [];
      d.todos.forEach(function (this: unknown, t, i, list) {
        expect(isDraft(t)).toBe(true);
        expect(t).toBe(d.todos.get(i)); // the one draft of that slot
        expect(list).toBe(d.todos);
        expect(this).toBe(seen);
        seen.push(i);
      }, seen);
      expect(seen).toEqual(todos(200).map((t) => t.id));
    });
  });

  it('a walk that edits one element shares every other with the base, and records what get(i) would', () => {
    const viaWalk = produceWithPatches(base, (d) => { for (const t of d.todos) if (t.id === 150) t.done = true; });
    const viaGet = produceWithPatches(base, (d) => { d.todos.get(150).done = true; });
    expect(viaWalk[0]).toBe(viaGet[0]);
    expect(viaWalk[1]).toEqual(viaGet[1]);
    expect(viaWalk[2]).toEqual(viaGet[2]);
    expect(viaWalk[0].todos.get(149)).toBe(base.todos.get(149));
    expectPatchRoundTrip(base, ...viaWalk);
  });

  it('a walk that edits nothing is the base, with no patches', () => {
    const [next, patches, inverse] = produceWithPatches(base, (d) => { for (const t of d.todos) void t.id; });
    expect(next).toBe(base);
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });

  it('is by index and live, as an Array’s iterator is', () => {
    const next = produce(ValueList.of(1, 2, 3), (d) => {
      const seen: number[] = [];
      for (const x of d) {
        seen.push(x);
        if (x === 1) d.push(4);
        if (x === 2) d.remove(2); // the 3
      }
      expect(seen).toEqual([1, 2, 4]);
    });
    expect(next).toBe(ValueList.of(1, 2, 4));
  });

  it('elements that cannot be drafted come as they are, assigned ones included', () => {
    const assigned = intern({ id: 9, done: false });
    const next = produce(intern({ xs: ValueList.of<unknown>(1, 'a', null, undefined) }), (d) => {
      expect([...d.xs]).toEqual([1, 'a', null, undefined]);
      d.xs.push(assigned); // a canonical placed in the draft: drafted on the way out, copy-on-write
      for (const x of d.xs) if (isDraft(x)) (x as Todo).done = true;
    });
    expect(next.xs.get(4)).toBe(intern({ id: 9, done: true }));
    expect(assigned.done).toBe(false);
  });

  it('toArray() is the value’s: a frozen canonical array of values, whatever has been drafted', () => {
    produce(base, (d) => {
      for (const t of d.todos) if (t.id < 2) t.done = true;
      const arr = d.todos.toArray();
      expect(arr.some((t) => isDraft(t))).toBe(false);
      expect(Object.isFrozen(arr)).toBe(true);
      expect(arr[0]).toBe(intern({ id: 0, done: true }));
      expect(arr[5]).toBe(base.todos.get(5));
      expect(d.todos.slice(0, 1)).toBe(ValueList.of({ id: 0, done: true })); // and so is every other snapshot read
    });
  });
});

describe('DraftMap iteration', () => {
  const base = intern({ m: ValueMap.from(todos(100).map((t) => [t.id, t] as const)) });

  it('entries, values, forEach and the iterator hand out drafts; keys stay values', () => {
    const done = intern({ m: ValueMap.from(todos(100).map((t) => [t.id, { ...t, done: true }] as const)) });
    expect(produce(base, (d) => { for (const [, t] of d.m) t.done = true; })).toBe(done);
    expect(produce(base, (d) => { for (const [, t] of d.m.entries()) t.done = true; })).toBe(done);
    expect(produce(base, (d) => { for (const t of d.m.values()) t.done = true; })).toBe(done);
    expect(produce(base, (d) => { d.m.forEach((t, k) => { expect(t).toBe(d.m.get(k)); t.done = true; }); })).toBe(done);
    const keyed = intern({ m: ValueMap.from([[{ k: 1 }, { v: 1 }]]) });
    produce(keyed, (d) => {
      for (const k of d.m.keys()) expect(isDraft(k)).toBe(false);
      for (const [k, v] of d.m) expect([isDraft(k), isDraft(v)]).toEqual([false, true]);
    });
  });

  it('each key comes once, through sets, deletes, edits and a clear', () => {
    produce(base, (d) => {
      d.m.get(3)!.done = true; // child-drafted
      d.m.set(4, { id: 4, done: true }); // assigned over a base key
      d.m.delete(5);
      d.m.set(1000, { id: 1000, done: false }); // new
      const keys = [...d.m].map(([k]) => k);
      expect(keys.length).toBe(d.m.size);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.includes(5)).toBe(false);
      expect([...d.m.keys()].sort((a, b) => a - b)).toEqual([...keys].sort((a, b) => a - b));
      expect([...d.m].map(([k]) => k)).toEqual(keys); // walking drafted everything; a second walk is the same walk
      for (const [k, t] of d.m) expect(t.id).toBe(k);
      d.m.clear();
      d.m.set(7, { id: 7, done: false }); // a base key, after the clear
      d.m.set(2000, { id: 2000, done: false });
      expect([...d.m].map(([k]) => k).sort((a, b) => a - b)).toEqual([7, 2000]);
      for (const t of d.m.values()) t.done = true;
    });
  });

  it('a walk that edits one entry records what get(k) would; one that edits nothing is the base', () => {
    const viaWalk = produceWithPatches(base, (d) => { for (const [k, t] of d.m) if (k === 42) t.done = true; });
    const viaGet = produceWithPatches(base, (d) => { d.m.get(42)!.done = true; });
    expect(viaWalk).toEqual(viaGet);
    expect(viaWalk[0]).toBe(viaGet[0]);
    expectPatchRoundTrip(base, ...viaWalk);
    const [next, patches] = produceWithPatches(base, (d) => { for (const [, t] of d.m) void t.id; });
    expect(next).toBe(base);
    expect(patches).toEqual([]);
  });
});

describe('set members stay values (D57)', () => {
  // A set holds its members by content, so editing one is removing it and
  // adding another, which may already be there. That is said, not drafted.
  const base = intern({ tags: ValueSet.from([{ name: 'a', n: 1 }, { name: 'a', n: 2 }, { name: 'b', n: 1 }]) });

  it('iteration hands out the canonical members, on both kinds of set', () => {
    produce(intern({ s: base.tags, o: OrderedSet.from([{ v: 1 }]) }), (d) => {
      for (const m of d.s) expect(isDraft(m)).toBe(false);
      for (const m of d.o) expect(isDraft(m)).toBe(false);
      d.s.forEach((m) => expect(isDraft(m)).toBe(false));
    });
  });

  it('the documented ways to change a member: delete and add, or map; members that become equal are one', () => {
    const one = produce(base, (d) => {
      // Over a copy: a member added while the set itself is being walked is
      // visited too, as on a native Set, and this loop would never end.
      for (const t of [...d.tags]) {
        if (t.name !== 'b') continue;
        d.tags.delete(t);
        d.tags.add({ ...t, n: 9 });
      }
    });
    expect(one.tags).toBe(ValueSet.from([{ name: 'a', n: 1 }, { name: 'a', n: 2 }, { name: 'b', n: 9 }]));
    const [all, patches, inverse] = produceWithPatches(base, (d) => {
      d.tags = castDraft(d.tags.map((t) => ({ ...t, n: 0 })));
    });
    expect(all.tags).toBe(ValueSet.from([{ name: 'a', n: 0 }, { name: 'b', n: 0 }]));
    expect(all.tags.size).toBe(2); // three members went in
    expectPatchRoundTrip(base, all, patches, inverse);
  });

  it('a set that is a member of a set changes identity with its content, all the way up', () => {
    const inner = ValueSet.from([1, 2]);
    const outer = intern({ s: ValueSet.from([inner, ValueSet.from([1, 2, 3])]) });
    const next = produce(outer, (d) => {
      d.s.delete(inner);
      d.s.add(inner.add(3)); // now equal to the other member
    });
    expect(next.s).toBe(ValueSet.from([ValueSet.from([1, 2, 3])]));
  });
});

describe('DraftOrderedMap iteration', () => {
  const base = intern({ m: OrderedMap.from(todos(100).map((t) => [`k${t.id}`, t] as const)) });

  it('hands out drafts in order, and edits land', () => {
    const next = produce(base, (d) => {
      const order: string[] = [];
      for (const [k, t] of d.m) {
        order.push(k);
        expect(t).toBe(d.m.get(k));
        if (t.id % 2 === 0) t.done = true;
      }
      expect(order).toEqual([...base.m.keys()]);
      d.m.forEach((t) => { if (t.id === 1) t.done = true; });
      for (const t of d.m.values()) if (t.id === 3) t.done = true;
    });
    expect(next.m).toBe(OrderedMap.from(todos(100).map((t) => [`k${t.id}`, { ...t, done: t.id % 2 === 0 || t.id === 1 || t.id === 3 }] as const)));
    const viaWalk = produceWithPatches(base, (d) => { for (const [, t] of d.m) if (t.id === 9) t.done = true; });
    expect(viaWalk).toEqual(produceWithPatches(base, (d) => { d.m.get('k9')!.done = true; }));
    expectPatchRoundTrip(base, ...viaWalk);
  });
});
