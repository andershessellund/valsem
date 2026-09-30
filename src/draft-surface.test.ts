// ---------------------------------------------------------------------------
// A draft offers what its value offers, and a value has no mutator's name.
//
// The drafts grew method by method, and drifted: DraftList had no `insert`,
// `remove` or `forEach` (ValueList's own vocabulary) and no `shift`/`unshift`
// (which a plain array in the same recipe has), DraftSet had no `entries()`,
// DraftOrderedMap no `valueAt()`. The first test is the one that would have
// caught it: every method of a value class is on its draft, no exceptions.
// What edits, edits the draft. What does not (`slice`, `concat`, the set
// algebra, `keyList`, and the value's copying edits, `with`, `pushed`, …)
// answers about the value the draft would be right now, its snapshot, and
// gives back values: `get`, `at`, iteration and `find` hand out drafts. The
// second test is D59's other half: no value has a name that mutates on
// `Array`, `Map`, `Set` or its own draft, so `list.push(x)` cannot be written
// where it would do nothing.
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
import { COLLECTIONS, VALUE_TYPES } from './roster.test-helpers.js';

type Loose = (...args: unknown[]) => unknown;

const members = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && !name.startsWith('_'));

describe('a draft has its value\u2019s methods', () => {
  it.each(COLLECTIONS.map((c) => [c.name, c.type, c.draftType] as const))('%s', (_, Value, DraftClass) => {
    const onDraft = new Set(members(DraftClass.prototype));
    const missing = members(Value.prototype).filter((name) => !onDraft.has(name));
    expect(missing).toEqual([]);
  });
});

describe('a value has no mutator\u2019s name (D59)', () => {
  // What mutates on `Array`, `Map` (Node 26's `getOrInsert` pair included) and `Set`, and the drafts' own verbs.
  const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear', 'getOrInsert', 'getOrInsertComputed', 'insert', 'remove', 'insertAt', 'setMany'];
  it.each(VALUE_TYPES.map((c) => [c.name, c.type] as const))('%s', (_, Value) => {
    expect(members(Value.prototype).filter((name) => MUTATORS.includes(name))).toEqual([]);
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

describe('DraftSet.entries and DraftOrderedMap.at', () => {
  it('entries: [value, value] pairs of what the draft holds', () => {
    produce(intern({ s: ValueSet.from(['a']) }), (d) => {
      d.s.add('b');
      d.s.delete('a');
      expect([...d.s.entries()]).toEqual([['b', 'b']]);
    });
  });

  it('at: the entry at a position, its value drafted, so it can be edited through', () => {
    const base = intern({ m: OrderedMap.from([['a', { v: 1 }], ['b', { v: 2 }]]) });
    const next = produce(base, (d) => {
      d.m.at(1)![1].v = 20;
      expect(d.m.at(1)![1]).toBe(d.m.get('b'));
      expect(d.m.at(-1)![1]).toBe(d.m.get('b'));
      expect(d.m.at(2)).toBeUndefined();
      for (const i of [0.5, NaN]) expect(() => d.m.at(i)).toThrow(RangeError);
    });
    expect(next.m.at(1)).toEqual(['b', { v: 20 }]);
    expect(next.m.at(0)![1]).toBe(base.m.at(0)![1]);
  });
});

describe('what does not edit answers about the value the draft would be right now', () => {
  it('DraftList.slice and concat: values, with the pending edits in them', () => {
    const base = intern({ l: ValueList.of({ n: 1 }, { n: 2 }, { n: 3 }), top: ValueList.empty<{ n: number }>() });
    const next = produce(base, (d) => {
      d.l.at(0)!.n = 10; // a pending edit through a child draft
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

  it('DraftList: the copying edits are what-ifs, as current(draft) would answer, and edit nothing', () => {
    const base = intern({ l: ValueList.of(1, 2, 3) });
    const [next, patches] = produceWithPatches(base, (d) => {
      d.l.push(4); // a pending edit, so the what-ifs answer about [1, 2, 3, 4]
      const now = current(d.l);
      expect(d.l.with(0, 9)).toBe(now.with(0, 9));
      expect(d.l.pushed(5, 6)).toBe(now.pushed(5, 6));
      expect(d.l.popped()).toBe(now.popped());
      expect(d.l.shifted()).toBe(now.shifted());
      expect(d.l.unshifted(0)).toBe(now.unshifted(0));
      expect(d.l.inserted(1, 7)).toBe(now.inserted(1, 7));
      expect(d.l.removed(1)).toBe(now.removed(1));
      expect(d.l.toSpliced(1, 2, 8)).toBe(now.toSpliced(1, 2, 8));
      expect(d.l.toSpliced(1)).toBe(now.toSpliced(1));
      expect(current(d.l)).toBe(now); // none of it edited
    });
    expect(next.l).toBe(ValueList.of(1, 2, 3, 4));
    expect(patches.length).toBe(1); // the push, and nothing else
  });

  it('a what-if checks its position in the draft\u2019s name, before the snapshot is built', () => {
    produce(intern({ l: ValueList.of(1, 2, 3) }), (d) => {
      expect(() => d.l.with(3, 0)).toThrow('DraftList.with: index 3 out of range [0, 3)');
      expect(() => d.l.removed(-1)).toThrow('DraftList.removed: index -1 out of range [0, 3)');
      expect(() => d.l.inserted(4, 0)).toThrow('DraftList.inserted: index 4 out of range [0, 3]');
      expect(() => d.l.toSpliced(4)).toThrow('DraftList.toSpliced: start 4 out of range [0, 3]');
      expect(() => (d.l as unknown as Record<string, Loose>).toSpliced!(0, undefined, 9)).toThrow('DraftList.toSpliced: deleteCount must be an integer, got undefined');
      expect(() => (d.l as unknown as Record<string, Loose>).toSpliced!(0, undefined)).toThrow('DraftList.toSpliced: deleteCount must be an integer, got undefined');
      expect(() => d.l.toSpliced(0, -1)).toThrow('DraftList.toSpliced: deleteCount must not be negative');
    });
  });

  it('DraftSet, DraftMap and the ordered drafts: with, added, deleted and insertedAt are what-ifs too', () => {
    produce(intern({ s: ValueSet.of(1, 2), m: ValueMap.from([['a', 1]]), os: OrderedSet.of('p', 'q'), om: OrderedMap.from([['a', 1]]) }), (d) => {
      d.s.add(3);
      expect(d.s.added(4)).toBe(ValueSet.of(1, 2, 3, 4));
      expect(d.s.deleted(1)).toBe(ValueSet.of(2, 3));
      d.m.set('b', 2);
      expect(d.m.with('c', 3)).toBe(ValueMap.from([['a', 1], ['b', 2], ['c', 3]]));
      expect(d.m.deleted('a')).toBe(ValueMap.from([['b', 2]]));
      d.os.add('r');
      expect(d.os.added('s')).toBe(OrderedSet.of('p', 'q', 'r', 's'));
      expect(d.os.deleted('p')).toBe(OrderedSet.of('q', 'r'));
      expect(d.os.insertedAt(0, 'o')).toBe(OrderedSet.of('o', 'p', 'q', 'r'));
      expect(() => d.os.insertedAt(0, 'p')).toThrow('DraftOrderedSet.insertedAt: the value is already a member');
      expect(() => d.os.insertedAt(4, 'z')).toThrow('DraftOrderedSet.insertedAt: index 4 out of range [0, 3]');
      d.om.set('b', 2);
      expect(d.om.with('c', 3)).toBe(OrderedMap.from([['a', 1], ['b', 2], ['c', 3]]));
      expect(d.om.deleted('a')).toBe(OrderedMap.from([['b', 2]]));
      expect(d.om.insertedAt(0, 'z', 0)).toBe(OrderedMap.from([['z', 0], ['a', 1], ['b', 2]]));
      expect(() => d.om.insertedAt(0, 'a', 0)).toThrow('DraftOrderedMap.insertedAt: the key is already present');
      expect(() => d.om.insertedAt(3, 'z', 0)).toThrow('DraftOrderedMap.insertedAt: index 3 out of range [0, 2]');
      expect([d.s.size, d.m.size, d.os.size, d.om.size]).toEqual([3, 2, 3, 2]); // nothing edited
    });
  });

  it('the ordered drafts\u2019 insertAt reports in the draft\u2019s name', () => {
    produce(intern({ os: OrderedSet.of('p'), om: OrderedMap.from([['a', 1]]) }), (d) => {
      expect(() => d.os.insertAt(0, 'p')).toThrow('DraftOrderedSet.insertAt: the value is already a member — a member has one position; delete it first to move it');
      expect(() => d.os.insertAt(2, 'z')).toThrow('DraftOrderedSet.insertAt: index 2 out of range [0, 1]');
      expect(() => d.om.insertAt(0, 'a', 0)).toThrow('DraftOrderedMap.insertAt: the key is already present — a key has one position; delete it first to move it');
      expect(() => d.om.insertAt(2, 'z', 0)).toThrow('DraftOrderedMap.insertAt: index 2 out of range [0, 1]');
    });
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
  it('as ValueList.toSpliced and Array.prototype.splice do', () => {
    const base = ValueList.of(1, 2, 3, 4);
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      expect(d.splice(1).length).toBe(3);
    });
    expect(next).toBe(ValueList.of(1));
    expectPatchRoundTrip(base, next, patches, inverse);
  });
});
