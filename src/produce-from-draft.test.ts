// ---------------------------------------------------------------------------
// A draft as the BASE of produce stands for the value it is right now.
//
// Function A calls function B, both are built on produce, and A hands B a
// piece of its draft. B must behave as it does anywhere else: take a value,
// return a value, edit nothing. So `produce(draft, recipe)` is
// `produce(current(draft), recipe)`, for every kind of draft. Before, a plain
// draft happened to work and a collection draft (or a plain one holding one)
// failed with "DraftList has no [hashCode]".
//
// This file deliberately does NOT import `current`: a bundle with produce and
// no current() must work too, and current.ts is what used to wire the
// snapshot of the two core draft kinds in.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { applyPatches, castDraft, isDraft, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { deepHash } from './deep-hash.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

interface Todo { readonly id: number; readonly done: boolean }
interface Sub { readonly n: number; readonly todos: ValueList<Todo> }
interface State { readonly sub: Sub; readonly list: ValueList<number>; readonly log: readonly string[] }

const base: State = intern({ sub: { n: 1, todos: ValueList.of({ id: 1, done: false }) }, list: ValueList.of(1, 2), log: [] });

// B: ordinary functions from value to value, which happen to use produce.
const bump = (sub: Sub): Sub => produce(sub, (d) => void d.n++);
const finishAll = (sub: Sub): Sub => produce(sub, (d) => d.todos.forEach((_, i) => void (d.todos.get(i).done = true)));
const append = produce<ValueList<number>, [number]>((d, x) => void d.push(x)); // the curried form

describe('a function built on produce, called from inside another recipe', () => {
  it('returns the value it would return for the draft’s current value, for every kind of draft', () => {
    produce(base, (d) => {
      expect(bump(d.sub as unknown as Sub)).toBe(intern({ n: 2, todos: base.sub.todos })); // a plain draft
      expect(append(d.list as unknown as ValueList<number>, 3)).toBe(ValueList.of(1, 2, 3)); // a collection draft
      expect(finishAll(d.sub as unknown as Sub).todos).toBe(ValueList.of({ id: 1, done: true })); // a plain draft holding one
    });
  });

  it('sees the edits made so far', () => {
    produce(base, (d) => {
      d.sub.n = 10;
      d.sub.todos.push({ id: 2, done: false });
      d.list.push(3);
      const next = finishAll(bump(d.sub as unknown as Sub));
      expect(next).toBe(intern({ n: 11, todos: ValueList.of({ id: 1, done: true }, { id: 2, done: true }) }));
      expect(append(d.list as unknown as ValueList<number>, 4)).toBe(ValueList.of(1, 2, 3, 4));
    });
  });

  it('edits nothing: the caller’s draft is as it was, so a what-if can be asked twice', () => {
    const next = produce(base, (d) => {
      const a = bump(d.sub as unknown as Sub);
      const b = bump(d.sub as unknown as Sub);
      expect(a).toBe(b); // pure: not 2 and then 3
      expect(d.sub.n).toBe(1);
    });
    expect(next).toBe(base);
  });

  it('and the caller uses the result like any other value', () => {
    const next = produce(base, (d) => {
      d.sub = castDraft(finishAll(bump(d.sub as unknown as Sub)));
      d.list = castDraft(append(d.list as unknown as ValueList<number>, 3));
      d.sub.n++; // still editable through its slot
    });
    expect(next).toBe(intern({ sub: { n: 3, todos: ValueList.of({ id: 1, done: true }) }, list: ValueList.of(1, 2, 3), log: [] }));
  });

  it('the result is a value, not a draft: it outlives the recipe', () => {
    const kept: Sub[] = [];
    produce(base, (d) => void kept.push(bump(d.sub as unknown as Sub)));
    expect(kept[0]!.n).toBe(2);
    expect(Object.isFrozen(kept[0])).toBe(true);
  });
});

describe('the patch functions take a draft the same way', () => {
  it('produceWithPatches: patches relative to the value the draft is right now', () => {
    produce(base, (d) => {
      d.sub.n = 5;
      const now = intern({ n: 5, todos: base.sub.todos });
      const [next, patches, inverse] = produceWithPatches(d.sub as unknown as Sub, (s) => void s.n++);
      expect(next).toBe(intern({ n: 6, todos: base.sub.todos }));
      expectPatchRoundTrip(now, next, patches, inverse);
    });
  });

  it('applyPatches: onto the value the draft is right now, an empty list included', () => {
    produce(base, (d) => {
      d.list.push(3);
      expect(applyPatches(d.list as unknown as ValueList<number>, [{ kind: 'list.set', path: [], index: 0, value: 9 }])).toBe(ValueList.of(9, 2, 3));
      expect(applyPatches(d.list as unknown as ValueList<number>, [])).toBe(ValueList.of(1, 2, 3));
      expect(d.list.get(0)).toBe(1);
    });
  });
});

describe('where a value is required, a draft stands for the value it holds right now', () => {
  // A set member, a map key, an argument to intern, deepHash or memoize: none
  // of them is a location a draft could be followed from (D36), so "right now"
  // is the only reading there is. Every kind of draft, however nested.
  it('intern, deepHash, a HashMap key, a memoize argument', () => {
    produce(base, (d) => {
      d.list.push(3);
      d.sub.n = 2;
      const listNow = ValueList.of(1, 2, 3);
      const subNow = intern({ n: 2, todos: ValueList.of({ id: 1, done: false }) });
      expect(intern(d.list)).toBe(listNow);
      expect(intern(d.sub)).toBe(subNow); // a record draft that holds a collection
      expect(intern({ holds: d.list, also: [d.sub] })).toBe(intern({ holds: listNow, also: [subNow] }));
      expect(deepHash(d.list)).toBe(deepHash(listNow));
      expect(deepHash(d.sub)).toBe(deepHash(subNow));
      const h = new HashMap<unknown, number>().set(d.list, 1).set(d.sub, 2);
      expect([h.get(listNow), h.get(subNow)]).toEqual([1, 2]);
      expect([...h.keys()].some(isDraft)).toBe(false);
      const len = memoize((l: ValueList<number>) => l.length);
      expect(len(d.list as unknown as ValueList<number>)).toBe(3);
      expect(intern(d.log)).toBe(base.log); // an untouched draft is its base, and nothing is walked
    });
  });

  it('no collection ever holds a draft as a key or a member, and what it holds does not follow the draft', () => {
    let kept: { vm: ValueMap<unknown, number>; om: OrderedMap<unknown, number>; vs: ValueSet<unknown>; os: OrderedSet<unknown> } | undefined;
    const next = produce(intern({ byKey: ValueMap.empty<unknown, number>(), seen: ValueSet.empty<unknown>(), sub: base.sub, list: base.list }), (d) => {
      const before = intern({ n: 1, todos: ValueList.of({ id: 1, done: false }) });
      // The drafts' own entry points, with a record draft and a collection draft as KEY and as MEMBER.
      d.byKey.set(d.sub, 1).set(d.list, 2);
      d.seen.add(d.sub).add(d.list);
      expect([d.byKey.has(d.sub), d.byKey.get(d.list), d.seen.has(d.sub), d.seen.has(d.list)]).toEqual([true, 2, true, true]);
      // The values' own entry points, called inside the recipe.
      kept = {
        vm: ValueMap.empty<unknown, number>().set(d.sub, 1).set(d.list, 2),
        om: OrderedMap.empty<unknown, number>().set(d.sub, 1).insertAt(0, d.list, 2),
        vs: ValueSet.from<unknown>([d.sub, d.list]),
        os: OrderedSet.of<unknown>(d.sub).insertAt(0, d.list),
      };
      for (const keys of [d.byKey.keys(), d.seen, kept.vm.keys(), kept.om.keys(), kept.vs, kept.os]) {
        for (const k of keys) expect(isDraft(k)).toBe(false);
      }
      expect(kept.vm.has(before)).toBe(true);
      // Edits made afterwards do not reach what was handed over...
      d.sub.n = 99;
      d.list.push(3);
      expect(d.seen.has(before)).toBe(true);
      expect(d.seen.has(d.sub)).toBe(false); // ...and a lookup with the draft asks about what it holds NOW
      expect(d.seen.delete(d.sub)).toBe(false);
    });
    const before = intern({ n: 1, todos: ValueList.of({ id: 1, done: false }) });
    expect(next.seen).toBe(ValueSet.from<unknown>([before, ValueList.of(1, 2)]));
    expect(next.byKey).toBe(ValueMap.from<unknown, number>([[before, 1], [ValueList.of(1, 2), 2]]));
    expect(next.sub.n).toBe(99); // the state itself kept following the draft
    // The recipe is over and its drafts are revoked; what was kept is whole.
    expect(kept!.vm).toBe(ValueMap.from<unknown, number>([[before, 1], [ValueList.of(1, 2), 2]]));
    expect(kept!.vs).toBe(ValueSet.from<unknown>([before, ValueList.of(1, 2)]));
    expect([...kept!.os]).toEqual([ValueList.of(1, 2), before]);
    expect([...kept!.om.keys()]).toEqual([ValueList.of(1, 2), before]);
  });

  it('a draft whose recipe has ended is no base: it has no "right now"', () => {
    let list: unknown;
    let sub: unknown;
    produce(base, (d) => {
      list = d.list;
      sub = d.sub;
    });
    expect(() => produce(list, () => {})).toThrow(/this draft escaped its produce/);
    expect(() => produce(sub, () => {})).toThrow(TypeError); // a revoked Proxy: the engine's own error
    // ...and no value either: there is no "right now" to take.
    expect(() => intern(list)).toThrow(/this draft escaped its produce/);
    expect(() => ValueSet.from([list])).toThrow(/this draft escaped its produce/);
    expect(() => intern(sub)).toThrow(TypeError);
  });
});
