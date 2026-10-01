// produce never modifies its input, through any path (DESIGN.md §11, law 14;
// D61). The base is interned before it is drafted, so every object a recipe
// can reach is frozen: the ways a recipe could get hold of a raw input's own
// objects — the doors the 1.0.0 review found one by one — all meet a frozen
// object and throw, and the input is as it was. Each row is one door.
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, applyPatches, draftOf, isDraft } from './produce.js';
import { original } from './current.js';
import { intern, isCanonical } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';

type Row = { k: number };
const list = (): { a: Row[] } => ({ a: [{ k: 1 }, { k: 2 }] });
const rec = (): { a: Row } => ({ a: { k: 1 } });

/** Runs `recipe` over `input` through produce and asserts the input is untouched; `write` is what the recipe did to it, expected to throw. */
const door = (name: string, mk: () => object, recipe: (d: never) => void): void => {
  it(name, () => {
    const input = mk();
    const before = JSON.stringify(input, (_, v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Reflect.ownKeys(v).map((k) => [String(k), (v as Record<PropertyKey, unknown>)[k]])) : v));
    expect(() => produce(input as never, recipe as never)).toThrow(TypeError); // a write to a frozen object
    expect(JSON.stringify(input, (_, v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Reflect.ownKeys(v).map((k) => [String(k), (v as Record<PropertyKey, unknown>)[k]])) : v))).toBe(before);
  });
};

describe('produce never modifies its input', () => {
  door('a sort comparator writing into its arguments', list, (d: { a: Row[] }) => { d.a.sort((p, q) => { p.k = 9; return q.k - p.k; }); });
  door("a property descriptor's value, on a record draft", rec, (d: { a: Row }) => { Object.getOwnPropertyDescriptor(d, 'a')!.value.k = 9; });
  door("a property descriptor's value, on an array draft", list, (d: { a: Row[] }) => { Object.getOwnPropertyDescriptor(d.a, '0')!.value.k = 9; });
  door('original(d): the input itself, by name, is its frozen canonical', rec, (d: { a: Row }) => { original(d).a.k = 9; });
  door('a non-enumerable own property is absent, so a write through it fails', () => Object.defineProperty({ x: 1 }, 'h', { value: { k: 1 }, enumerable: false }), (d: { h: Row }) => { d.h.k = 9; });

  it('the paths that draft never reached the input either: removal verbs, iteration, spread, copying methods', () => {
    const input = list();
    const next = produce(input, (d) => {
      d.a.splice(0, 1)[0]!.k = 9;
      d.a.shift()!.k = 9;
      d.a.push({ k: 3 }, { k: 4 });
      for (const e of d.a) e.k += 10;
      ({ ...d }).a[0]!.k += 100;
      d.a.toSorted((p, q) => q.k - p.k)[0]!.k += 1000;
    });
    expect(input).toEqual({ a: [{ k: 1 }, { k: 2 }] });
    expect(next).toBe(intern({ a: [{ k: 1113 }, { k: 14 }] })); // every write landed in a draft: the spread's and toSorted's elements are drafts too
  });

  it('original(d) of a raw input is its canonical, as the docs say: the value the draft was made from', () => {
    const input = rec();
    produce(input, (d) => {
      expect(original(d)).toBe(intern(input));
      expect(original(d)).not.toBe(input);
      expect(isCanonical(original(d))).toBe(true);
      expect(Object.isFrozen(original(d).a)).toBe(true);
    });
    const c = intern(rec());
    produce(c, (d) => { expect(original(d)).toBe(c); }); // a canonical input is handed back as itself
  });

  it('a non-value anywhere in a raw input is rejected before the recipe runs, even where the recipe would have removed it', () => {
    const recipe = (d: { d?: Date; x: number }) => { delete d.d; };
    expect(() => produce({ d: new Date(0), x: 1 }, recipe)).toThrow(/Date cannot be interned/);
    expect(() => produceWithPatches({ d: new Date(0), x: 1 }, recipe)).toThrow(/Date cannot be interned/);
    expect(() => applyPatches({ d: new Date(0), x: 1 }, [])).toThrow(/Date cannot be interned/);
  });

  it('draftOf(raw) is a draft over its canonical, so the raw material is never written either', () => {
    const mine = { k: 1 };
    const next = produce(intern({ a: [] as Row[] }), (d) => {
      const dr = draftOf(mine);
      expect(isDraft(dr)).toBe(true);
      expect(original(dr)).toBe(intern(mine));
      dr.k = 2;
      d.a.push(dr);
    });
    expect(mine).toEqual({ k: 1 });
    expect(next).toBe(intern({ a: [{ k: 2 }] }));
  });

  it('a draft given as the base stands for its current value, and the outer recipe is not edited through the inner one (D47)', () => {
    const outer = produce(intern({ sub: { n: 1 }, l: ValueList.of(1), m: ValueMap.from([['k', 1]]) }), (d) => {
      d.sub.n = 2;
      const inner = produce(d.sub, (e) => { e.n = 3; });
      expect(inner).toBe(intern({ n: 3 }));
      expect(d.sub.n).toBe(2);
      expect(produce(d.l, (e) => { e.push(2); })).toBe(ValueList.of(1, 2));
      expect(produce(d.m, (e) => { e.set('j', 2); })).toBe(ValueMap.from([['k', 1], ['j', 2]]));
    });
    expect(outer.sub).toBe(intern({ n: 2 }));
  });
});
