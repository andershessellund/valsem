// ---------------------------------------------------------------------------
// A draft offers what its value offers.
//
// The drafts grew method by method, and drifted: DraftList had no `insert`,
// `remove` or `forEach` (ValueList's own vocabulary) and no `shift`/`unshift`
// (which a plain array in the same recipe has), DraftSet had no `entries()`,
// DraftOrderedMap no `valueAt()`. The first test is the one that would have
// caught it: every method of a value class is on its draft, no exceptions.
// What edits, edits the draft. What does not (`slice`, `concat`, the set
// algebra, `keyList`) answers about the value the draft would be right now,
// its snapshot, and gives back values: `get`, iteration and `find` hand out
// drafts.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { castDraft, produce, produceWithPatches } from './produce.js';
import { current } from './current.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueSet } from './value-set.js';
import { ValueMap } from './value-map.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';
import { COLLECTIONS } from './roster.test-helpers.js';

const members = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && !name.startsWith('_'));

describe('a draft has its value\u2019s methods', () => {
  it.each(COLLECTIONS.map((c) => [c.name, c.type, c.draftType] as const))('%s', (_, Value, DraftClass) => {
    const onDraft = new Set(members(DraftClass.prototype));
    const missing = members(Value.prototype).filter((name) => !onDraft.has(name));
    expect(missing).toEqual([]);
  });
});

describe('DraftList: insert, remove, shift, unshift, forEach', () => {
  const base = intern({ l: ValueList.of('a', 'b', 'c') });

  it('edit as their names say, and their patches apply both ways', () => {
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      expect(d.l.insert(1, 'x')).toBe(d.l);
      expect(d.l.remove(0)).toBe('a');
      expect(d.l.shift()).toBe('x');
      expect(d.l.unshift('p', 'q')).toBe(4);
      const seen: [string, number][] = [];
      d.l.forEach((v, i, list) => {
        expect(list).toBe(d.l);
        seen.push([v, i]);
      });
      expect(seen).toEqual([['p', 0], ['q', 1], ['b', 2], ['c', 3]]);
    });
    expect(next.l.toArray()).toEqual(['p', 'q', 'b', 'c']);
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('name a place that exists, like the value\u2019s', () => {
    produce(base, (d) => {
      for (const i of [4, -1, 1.5, NaN]) expect(() => d.l.insert(i, 'x')).toThrow(RangeError);
      for (const i of [3, -1, 1.5, NaN]) expect(() => d.l.remove(i)).toThrow(RangeError);
      expect(() => d.l.remove(-1)).toThrow('DraftList.remove: index -1 out of range [0, 3)');
    });
    expect(produce(intern({ l: ValueList.empty<string>() }), (d) => void expect(d.l.shift()).toBeUndefined()).l.length).toBe(0);
  });

  it('nets out to the base', () => {
    expect(produce(base, (d) => void d.l.insert(1, 'x').remove(1))).toBe(base);
    expect(produce(base, (d) => { d.l.unshift('z'); d.l.shift(); })).toBe(base);
  });
});

describe('DraftSet.entries and DraftOrderedMap.valueAt', () => {
  it('entries: [value, value] pairs of what the draft holds', () => {
    produce(intern({ s: ValueSet.from(['a']) }), (d) => {
      d.s.add('b');
      d.s.delete('a');
      expect([...d.s.entries()]).toEqual([['b', 'b']]);
    });
  });

  it('valueAt: the value at a position, drafted, so it can be edited through', () => {
    const base = intern({ m: OrderedMap.from([['a', { v: 1 }], ['b', { v: 2 }]]) });
    const next = produce(base, (d) => {
      d.m.valueAt(1).v = 20;
      expect(d.m.valueAt(1)).toBe(d.m.get('b'));
      for (const i of [2, -1, 0.5, NaN]) expect(() => d.m.valueAt(i)).toThrow(RangeError);
    });
    expect(next.m.valueAt(1)).toEqual({ v: 20 });
    expect(next.m.valueAt(0)).toBe(base.m.valueAt(0));
  });
});

describe('what does not edit answers about the value the draft would be right now', () => {
  it('DraftList.slice and concat: values, with the pending edits in them', () => {
    const base = intern({ l: ValueList.of({ n: 1 }, { n: 2 }, { n: 3 }), top: ValueList.empty<{ n: number }>() });
    const next = produce(base, (d) => {
      d.l.get(0).n = 10; // a pending edit through a child draft
      d.l.push({ n: 4 });
      expect(d.l.slice(0, 2)).toBe(ValueList.of({ n: 10 }, { n: 2 }));
      expect(d.l.slice(-1)).toBe(ValueList.of({ n: 4 })); // a range: Array's bounds
      expect(d.l.slice()).toBe(current(d.l));
      expect(d.l.concat(ValueList.of({ n: 5 })).length).toBe(5);
      expect(d.l.length).toBe(4); // and the draft is as it was
      d.top = castDraft(d.l.slice(0, 2)); // a value goes straight back into a slot
    });
    expect(next.top).toBe(ValueList.of({ n: 10 }, { n: 2 }));
    expect(produce(base, (d) => void d.l.slice(1))).toBe(base); // looking is not editing
  });

  it('DraftList.setMany is an edit: all or nothing, the last write winning, with patches', () => {
    const base = intern({ l: ValueList.of(1, 2, 3) });
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      expect(d.l.setMany([[0, 9], [2, 7], [0, 8]])).toBe(d.l);
    });
    expect(next.l.toArray()).toEqual([8, 2, 7]);
    expectPatchRoundTrip(base, next, patches, inverse);
    const kept = produce(base, (d) => {
      expect(() => d.l.setMany([[0, 9], [3, 0]])).toThrow('DraftList.setMany: index 3 out of range [0, 3)');
    });
    expect(kept).toBe(base); // the good edit before the bad one was not applied
  });

  it('DraftSet: the algebra and the comparisons', () => {
    const next = produce(intern({ s: ValueSet.from([1, 2]), all: ValueSet.empty<number>() }), (d) => {
      d.s.add(3);
      d.s.delete(1);
      expect(d.s.union([9])).toBe(ValueSet.from([2, 3, 9]));
      expect(d.s.intersection([3, 4])).toBe(ValueSet.from([3]));
      expect(d.s.difference([3])).toBe(ValueSet.from([2]));
      expect(d.s.symmetricDifference([3, 4])).toBe(ValueSet.from([2, 4]));
      expect(d.s.isSubsetOf([1, 2, 3])).toBe(true);
      expect(d.s.isSupersetOf([2])).toBe(true);
      expect(d.s.isDisjointFrom([1])).toBe(true); // 1 was deleted a moment ago
      d.all = castDraft(d.s.union([1]));
    });
    expect(next.all).toBe(ValueSet.from([1, 2, 3]));
  });

  it('the ordered drafts: keyList and valueList', () => {
    produce(intern({ m: OrderedMap.from([['a', { v: 1 }]]), s: OrderedSet.from(['p']) }), (d) => {
      d.m.get('a')!.v = 5;
      d.m.set('b', { v: 2 });
      d.s.insertAt(0, 'o');
      expect(d.m.keyList).toBe(ValueList.of('a', 'b'));
      expect(d.m.valueList).toBe(ValueList.of({ v: 5 }, { v: 2 }));
      expect(d.s.valueList).toBe(ValueList.of('o', 'p'));
    });
  });
});

// Laws of every collection's draft, so over the roster.
describe.each(COLLECTIONS.map((c) => [c.name, c] as const))('a %s draft', (_name, c) => {
  // `any`: the drafts' shared surface (delete, clear, keys…), untyped across five classes.
  type AnyDraft = any;

  it('is made by produce, and says so to anyone who calls its constructor', () => {
    const Draft = c.draftType as unknown as new () => object;
    expect(() => new Draft()).toThrow(/created by produce\(\)/);
  });

  it('removing what is not there answers false and is not a change', () => {
    if (!c.distinct) return; // a list removes by index: index-arguments.test.ts
    const base = c.of('a', 'b');
    const [next, patches] = produceWithPatches(base, (d: AnyDraft) => {
      expect(d.delete('missing')).toBe(false);
      expect(d.delete({ not: 'there' })).toBe(false);
      expect(d.delete('a')).toBe(true);
      expect(d.delete('a')).toBe(false); // gone already
      c.draftAdd(d, 'a');
      expect(d.delete('a')).toBe(true);
    });
    expect(next).toBe(c.of('b'));
    expect(patches.length).toBeGreaterThan(0);
    expect(produce(base, (d: AnyDraft) => void d.delete('missing'))).toBe(base);
  });

  it('clearing what is already empty is not a change', () => {
    if (!c.distinct) return;
    const [next, patches, inverse] = produceWithPatches(c.empty(), (d: AnyDraft) => d.clear());
    expect(next).toBe(c.empty());
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });

  it('iterates what it holds right now: the base, less what was removed, plus what was added', () => {
    if (!c.distinct) return;
    produce(c.of('a', 'b', 'c'), (d: AnyDraft) => {
      d.delete('b');
      c.draftAdd(d, 'z');
      c.draftAdd(d, 'passing'); // added and removed again inside the recipe: never seen
      d.delete('passing');
      const now = ['a', 'c', 'z'];
      const sorted = (xs: Iterable<unknown>): unknown[] => (c.ordered ? [...xs] : [...xs].sort());
      expect(sorted(d.keys())).toEqual(now);
      expect(sorted(d.values())).toEqual(now);
      expect(sorted([...d.entries()].map(([k]: [unknown, unknown]) => k))).toEqual(now);
      expect(sorted([...d.entries()].map(([, v]: [unknown, unknown]) => v))).toEqual(now);
      expect(d.size).toBe(3);
    });
  });

  it('clearing after edits records the entries the recipe saw, and inverts', () => {
    if (!c.distinct) return;
    const base = c.of('a', 'b');
    const [next, patches, inverse] = produceWithPatches(base, (d: AnyDraft) => {
      c.draftAdd(d, 'c');
      d.delete('a');
      d.clear();
      c.draftAdd(d, 'kept');
    });
    expect(next).toBe(c.of('kept'));
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('a write that changes nothing records nothing, beside one that does', () => {
    const base = c.of('a', 'b');
    const [next, patches, inverse] = produceWithPatches(base, (d: AnyDraft) => {
      if (c.keyed) d.set('a', 'a'); // what it already holds
      else if (c.distinct) d.add('a');
      else d.set(0, 'a');
      c.draftAdd(d, 'z');
    });
    expect(next).toBe(c.of('a', 'b', 'z'));
    expect(patches.length).toBe(1);
    expectPatchRoundTrip(base, next, patches, inverse);
  });
});

describe('a map draft hands out a draft only for what can be drafted', () => {
  it.each([
    ['DraftMap', ValueMap],
    ['DraftOrderedMap', OrderedMap],
  ] as const)('%s.get of a primitive is the primitive, of a record a draft', (_name, Type) => {
    const base = Type.from<string, unknown>([['n', 1], ['text', 'x'], ['none', undefined], ['rec', { v: 1 }]]);
    const next = produce(base, (d) => {
      expect(d.get('n')).toBe(1);
      expect(d.get('text')).toBe('x');
      expect(d.get('none')).toBeUndefined();
      expect(d.get('missing')).toBeUndefined();
      (d.get('rec') as { v: number }).v = 2;
    });
    expect(next).toBe(Type.from<string, unknown>([['n', 1], ['text', 'x'], ['none', undefined], ['rec', { v: 2 }]]));
  });
});

describe('DraftList.splice with a start and nothing else removes to the end', () => {
  it('as ValueList.splice and Array.prototype.splice do', () => {
    const base = ValueList.of(1, 2, 3, 4);
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      expect(d.splice(1).length).toBe(3);
    });
    expect(next).toBe(ValueList.of(1));
    expectPatchRoundTrip(base, next, patches, inverse);
  });
});
