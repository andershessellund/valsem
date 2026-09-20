// ---------------------------------------------------------------------------
// JSON.stringify sees the collections.
//
// Without a `toJSON`, a class with `#private` state stringifies as `{}`: a
// state tree lost the contents of every collection in it, silently, while
// the three leaf value types (ValueDate, InternedString, RawArray) already
// had JSON parity. The shapes are the ones the collections are built from:
// a list or a set is an array of its elements, a map is an array of
// `[key, value]` pairs (keys are values, not strings, so there is no object
// form), which is what `from()` takes, so JSON-representable content makes
// the round trip. It is a VIEW, lossy like all JSON (D46): not a wire
// format, and for the unordered collections not even a stable string, since
// their order follows the per-process hash seed.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { intern } from './intern.js';
import { produce } from './produce.js';
import { current } from './current.js';
import { deepHash } from './deep-hash.js';
import { createInternPool } from './intern-pool.js';
import { equals, hashCode, interned } from './deep-equal.js';
import { toDraft, createDraftState, markChanged, assertUnrevoked, DRAFT_STATE, type DraftState } from './draft-core.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { HashMap } from './hash-map.js';
import { HashSet } from './hash-set.js';
import { ValueDate } from './value-date.js';
import { InternedString } from './interned-string.js';

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** Order-free comparison, for the collections whose order is not part of the value. */
const asSet = (items: unknown): Set<string> => new Set((items as unknown[]).map((x) => JSON.stringify(x)));

describe('a state tree stringifies whole', () => {
  it('the case that lost data: every collection was {}', () => {
    const state = intern({
      user: { id: 1, name: 'ada' },
      todos: ValueList.of({ id: 1, text: 'a' }, { id: 2, text: 'b' }),
      tags: OrderedSet.from(['x', 'y']),
      index: OrderedMap.from([['x', 1]]),
      at: ValueDate.from(0),
    });
    expect(JSON.stringify(state)).toBe(
      '{"user":{"id":1,"name":"ada"},' +
        '"todos":[{"id":1,"text":"a"},{"id":2,"text":"b"}],' +
        '"tags":["x","y"],' +
        '"index":[["x",1]],' +
        '"at":"1970-01-01T00:00:00.000Z"}',
    );
  });

  it('collections nest, and the leaf value types keep their own form', () => {
    const m = OrderedMap.from([
      ['list', ValueList.of<unknown>(1, ValueList.of(2, 3))],
      ['when', ValueDate.from(0)],
      ['name', InternedString.for('n')],
    ] as [string, unknown][]);
    expect(roundTrip(m)).toEqual([
      ['list', [1, [2, 3]]],
      ['when', '1970-01-01T00:00:00.000Z'],
      ['name', 'n'],
    ]);
  });
});

describe('the shapes', () => {
  it('ValueList: the elements, in order', () => {
    expect(JSON.stringify(ValueList.of<unknown>(1, 'a', null, { k: [true] }))).toBe('[1,"a",null,{"k":[true]}]');
    expect(JSON.stringify(ValueList.empty())).toBe('[]');
    const big = Array.from({ length: 5000 }, (_, i) => i); // past the open tail, into the tree
    expect(roundTrip(ValueList.from(big))).toEqual(big);
  });

  it('OrderedSet and HashSet: the members, in insertion order', () => {
    expect(JSON.stringify(OrderedSet.from(['b', 'a', 'c']))).toBe('["b","a","c"]');
    expect(JSON.stringify(HashSet.from([{ b: 1 }, 'a', { b: 1 }]))).toBe('[{"b":1},"a"]');
  });

  it('ValueSet: the members, in no particular order', () => {
    expect(asSet(roundTrip(ValueSet.from([3, 'a', { k: 1 }, 3])))).toEqual(asSet([3, 'a', { k: 1 }]));
    expect(JSON.stringify(ValueSet.empty())).toBe('[]');
  });

  it('OrderedMap and HashMap: [key, value] pairs, in insertion order', () => {
    expect(JSON.stringify(OrderedMap.from([['b', 1], ['a', 2]]))).toBe('[["b",1],["a",2]]');
    expect(JSON.stringify(HashMap.from([[{ id: 1 }, 'x'], ['k', [1]]] as [unknown, unknown][]))).toBe('[[{"id":1},"x"],["k",[1]]]');
  });

  it('ValueMap: [key, value] pairs, in no particular order', () => {
    const m = ValueMap.from([['a', 1], [2, 'two'], [{ table: 'users', id: 1 }, { row: true }]] as [unknown, unknown][]);
    expect(asSet(roundTrip(m))).toEqual(asSet([['a', 1], [2, 'two'], [{ table: 'users', id: 1 }, { row: true }]]));
    expect(JSON.stringify(ValueMap.empty())).toBe('[]');
  });

  it('a key is a value, so there is no object form, even when every key is a string', () => {
    expect(roundTrip(ValueMap.fromObject({ a: 1 }))).toEqual([['a', 1]]);
    expect(roundTrip(OrderedMap.fromObject({ a: 1 }))).toEqual([['a', 1]]);
  });
});

describe('JSON-representable content makes the round trip, through from()', () => {
  const leaf = fc.oneof(fc.string({ maxLength: 5 }), fc.integer(), fc.boolean(), fc.constant(null));
  const tree: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      leaf,
      fc.array(tie('node'), { maxLength: 3 }),
      fc.dictionary(fc.string({ maxLength: 4 }).filter((k) => k !== '__proto__'), tie('node'), { maxKeys: 3 }),
    ),
  })).node;

  it('ValueList, ValueSet, OrderedSet', () => {
    fc.assert(
      fc.property(fc.array(tree, { maxLength: 40 }), (items) => {
        const list = ValueList.from(items);
        expect(ValueList.from(roundTrip(list) as unknown[])).toBe(list);
        const set = ValueSet.from(items);
        expect(ValueSet.from(roundTrip(set) as unknown[])).toBe(set);
        const oset = OrderedSet.from(items);
        expect(OrderedSet.from(roundTrip(oset) as unknown[])).toBe(oset);
      }),
      { numRuns: 200 },
    );
  });

  it('ValueMap, OrderedMap', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(tree, tree), { maxLength: 40 }), (entries) => {
        const map = ValueMap.from(entries);
        expect(ValueMap.from(roundTrip(map) as [unknown, unknown][])).toBe(map);
        const omap = OrderedMap.from(entries);
        expect(OrderedMap.from(roundTrip(omap) as [unknown, unknown][])).toBe(omap);
      }),
      { numRuns: 200 },
    );
  });
});

describe('it is a view, and lossy like all JSON', () => {
  it('a fresh plain array every time: the collection keeps nothing, and the caller owns it', () => {
    const list = ValueList.of({ a: 1 }, { a: 2 });
    const out = list.toJSON();
    expect(out).not.toBe(list.toJSON());
    expect(Object.isFrozen(out)).toBe(false);
    out.length = 0;
    expect(list.length).toBe(2);
    expect(out).not.toBe(list.toArray());
    expect(list.toJSON()[0]).toBe(list.at(0)); // the elements are the canonical ones
    const pairs = OrderedMap.from([['k', { v: 1 }]]).toJSON();
    pairs[0]![1] = { v: 2 };
    expect(OrderedMap.from([['k', { v: 1 }]]).get('k')).toEqual({ v: 1 });
  });

  it('what JSON cannot say is lost, as in any array: undefined, symbols, which collection it was', () => {
    expect(JSON.stringify(ValueMap.from([['k', undefined]]))).toBe('[["k",null]]');
    expect(JSON.stringify(OrderedMap.from([[Symbol.for('s'), 1]]))).toBe('[[null,1]]');
    expect(JSON.stringify(ValueList.of(1, 2))).toBe(JSON.stringify([1, 2]));
    expect(JSON.stringify(OrderedSet.from([1, 2]))).toBe(JSON.stringify(ValueList.of(1, 2)));
    expect(() => JSON.stringify(ValueList.of(1n))).toThrow(TypeError); // loud, and JSON's own
  });

  it('HashMap values are stored as they are, so they stringify as they are', () => {
    const live = { toJSON: () => 'live object' };
    expect(JSON.stringify(HashMap.from([['k', live]]))).toBe('[["k","live object"]]');
  });
});

describe('inside a recipe, the drafts stringify as what they hold right now', () => {
  const base = intern({
    list: ValueList.of({ n: 1 }, { n: 2 }),
    map: ValueMap.from([['k', { v: 1 }]]),
    set: ValueSet.from(['a']),
    omap: OrderedMap.from([['x', { v: 1 }], ['y', { v: 2 }]]),
    oset: OrderedSet.from(['p', 'q']),
  });

  it('before any edit: the same as the values', () => {
    produce(base, (d) => {
      expect(JSON.stringify(d)).toBe(JSON.stringify(base));
    });
  });

  it('after edits: pushes, sets, edits made through a slot, deletes and inserts', () => {
    let seen: Record<string, unknown> = {};
    const next = produce(base, (d) => {
      d.list.push({ n: 3 });
      d.list.at(0)!.n = 10;
      d.map.get('k')!.v = 11;
      d.set.add('b');
      d.set.delete('a');
      d.omap.get('y')!.v = 22;
      d.omap.delete('x');
      d.omap.set('z', { v: 3 });
      d.oset.insertAt(0, 'o');
      seen = roundTrip(d) as Record<string, unknown>;
    });
    expect(seen.list).toEqual([{ n: 10 }, { n: 2 }, { n: 3 }]);
    expect(seen.map).toEqual([['k', { v: 11 }]]);
    expect(seen.set).toEqual(['b']);
    expect(seen.omap).toEqual([['y', { v: 22 }], ['z', { v: 3 }]]);
    expect(seen.oset).toEqual(['o', 'p', 'q']);
    // ...and it is what the recipe then produced.
    expect(asSet(Object.entries(seen))).toEqual(asSet(Object.entries(roundTrip(next) as object)));
  });

  it('a draft stringifies as current(draft) does, to the character', () => {
    produce(base, (d) => {
      d.map.set('a', { v: 0 }); // lands before 'k' or after it, as the hash has it: the snapshot's order, not the edit's
      d.map.get('k')!.v = 5;
      d.set.add('0');
      d.list.splice(1, 0, { n: 7 });
      d.omap.insertAt(0, 'w', { v: 0 });
      for (const k of ['list', 'map', 'set', 'omap', 'oset'] as const) {
        expect(JSON.stringify(d[k])).toBe(JSON.stringify(current(d[k])));
      }
    });
  });

  it('a drafted element of a [toDraft] type of your own stringifies as its value, not as its draft object', () => {
    // Iterating a draft hands out child drafts, and JSON.stringify cannot know
    // what an IntervalDraft stands for: the first toJSON gave {"l":[{}]}.
    const list = ValueList.of(Interval.of(1, 2));
    const map = ValueMap.from([['k', Interval.of(1, 2)]]);
    expect(JSON.stringify({ list, map })).toBe('{"list":["1..2"],"map":[["k","1..2"]]}');
    let seen = '';
    const next = produce({ list, map }, (d) => {
      d.list.at(0)!.hi = 9;
      d.map.get('k')!.hi = 9;
      seen = JSON.stringify(d);
    });
    expect(seen).toBe('{"list":["1..9"],"map":[["k","1..9"]]}');
    expect(JSON.stringify(next)).toBe(seen);
  });

  it('looking is not editing: stringifying a draft changes nothing', () => {
    expect(produce(base, (d) => void JSON.stringify(d))).toBe(base);
  });
});

// A draftable value type with a JSON form of its own, as a user would write one.
interface IntervalState extends DraftState<Interval> {
  hi: number;
  draft: IntervalDraft;
}
const intervals = createInternPool<Interval>();
class Interval {
  private constructor(readonly lo: number, readonly hi: number) {
    Object.freeze(this);
  }
  static of(lo: number, hi: number): Interval {
    const h = deepHash(['interval', lo, hi]);
    return intervals.lookup(h, (c) => c.lo === lo && c.hi === hi) ?? intervals.register(new Interval(lo, hi), h);
  }
  get [hashCode](): number {
    return deepHash(['interval', this.lo, this.hi]);
  }
  get [interned](): true {
    return true;
  }
  [equals](other: unknown): boolean {
    return other === this;
  }
  toJSON(): string {
    return `${this.lo}..${this.hi}`;
  }
  [toDraft](parent?: DraftState): IntervalState {
    const state = createDraftState<IntervalState>({
      kind: 'interval',
      parent,
      base: this,
      hi: this.hi,
      draft: null as unknown as IntervalDraft,
      finalize: (s) => Interval.of(this.lo, (s as IntervalState).hi),
      snapshot: (s) => Interval.of(this.lo, (s as IntervalState).hi),
    });
    state.draft = new IntervalDraft(state);
    return state;
  }
}
class IntervalDraft {
  declare readonly [DRAFT_STATE]: IntervalState;
  constructor(state: IntervalState) {
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }
  get hi(): number {
    return this[DRAFT_STATE].hi;
  }
  set hi(v: number) {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    s.hi = v;
    markChanged(s);
  }
}
