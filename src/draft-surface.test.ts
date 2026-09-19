// ---------------------------------------------------------------------------
// A draft offers what its value offers.
//
// The drafts grew method by method, and drifted: DraftList had no `insert`,
// `remove` or `forEach` (ValueList's own vocabulary) and no `shift`/`unshift`
// (which a plain array in the same recipe has), DraftSet had no `entries()`,
// DraftOrderedMap no `valueAt()`. The first test is the one that would have
// caught it: every method of a value class is on its draft, except the ones
// listed here with the reason they are not.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { applyPatches, produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { DraftList } from './draft-list.js';
import { DraftMap } from './draft-map.js';
import { DraftSet } from './draft-set.js';
import { DraftOrderedMap } from './draft-ordered-map.js';
import { DraftOrderedSet } from './draft-ordered-set.js';

/** Operations that BUILD A NEW VALUE from this one: on a draft, take `current(draft)` and call them on that. */
const BUILDS_A_VALUE = ['slice', 'concat', 'union', 'intersection', 'difference', 'symmetricDifference'];
/** Comparisons between values, and views that are values themselves. */
const OF_THE_VALUE = ['isSubsetOf', 'isSupersetOf', 'isDisjointFrom', 'keyList', 'valueList', 'setMany'];

const members = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && !name.startsWith('_'));

describe('a draft has its value\u2019s methods', () => {
  it.each([
    ['ValueList', ValueList, DraftList],
    ['ValueMap', ValueMap, DraftMap],
    ['ValueSet', ValueSet, DraftSet],
    ['OrderedMap', OrderedMap, DraftOrderedMap],
    ['OrderedSet', OrderedSet, DraftOrderedSet],
  ] as const)('%s', (_, Value, DraftClass) => {
    const onDraft = new Set(members(DraftClass.prototype));
    const missing = members(Value.prototype).filter(
      (name) => !onDraft.has(name) && !BUILDS_A_VALUE.includes(name) && !OF_THE_VALUE.includes(name),
    );
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
    expect(applyPatches(base, patches)).toBe(next);
    expect(applyPatches(next, inverse)).toBe(base);
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
