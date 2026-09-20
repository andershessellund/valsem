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
import { applyPatches, castDraft, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

interface Todo { readonly id: number; readonly done: boolean }
interface Sub { readonly n: number; readonly todos: ValueList<Todo> }
interface State { readonly sub: Sub; readonly list: ValueList<number>; readonly log: readonly string[] }

const base: State = intern({ sub: { n: 1, todos: ValueList.of({ id: 1, done: false }) }, list: ValueList.of(1, 2), log: [] });

// B: ordinary functions from value to value, which happen to use produce.
const bump = (sub: Sub): Sub => produce(sub, (d) => void d.n++);
const finishAll = (sub: Sub): Sub => produce(sub, (d) => d.todos.forEach((_, i) => void (d.todos.at(i)!.done = true)));
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
      expect(d.list.at(0)).toBe(1);
    });
  });
});

describe('a draft is still not a value anywhere else, and says so', () => {
  it('intern, a HashMap key, a memoize argument: "this is a draft", not "implement [hashCode]"', () => {
    produce(base, (d) => {
      d.list.push(3);
      expect(() => intern(d.list)).toThrow('intern: this DraftList is a draft, not a value — pass current(draft) for what it holds now.');
      expect(() => new HashMap().set(d.list, 1)).toThrow(/this DraftList is a draft, not a value/);
      expect(() => memoize((l: unknown) => l)(d.list)).toThrow(/this DraftList is a draft, not a value/);
      expect(() => ValueMap.empty().set('k', { holds: d.list })).toThrow(/this DraftList is a draft, not a value/);
    });
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
  });
});
