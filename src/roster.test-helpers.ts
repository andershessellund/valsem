// ---------------------------------------------------------------------------
// The roster: every value type valsem exports, in the one shape the LAW
// suites need.
//
// A law suite states one property of the whole library (-0 never enters
// canonical state; the markers are not own properties; every iterator obeys
// the protocol; whatever is stored was interned on the way in). It holds for
// EVERY type, so it runs over this table rather than over a list of its
// own: a hand-written list is complete on the day it is written, and the
// ordered collections arrived after most of them were. roster.test.ts checks
// the table against what index.ts exports, so a new value type that is not
// enrolled here fails the build, and once enrolled is under every law.
//
// What a law needs from one type is small: build an instance from items,
// read everything back out, ask for membership, add one more (persistently
// and through a draft), and name the iterators. A map is treated as holding
// each item twice, as a key and as that key's value, so that one statement
// ("everything read back is +0") covers both of its doors.
// ---------------------------------------------------------------------------
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { ValueDate } from './value-date.js';
import { InternedString } from './interned-string.js';
import { RawArray } from './raw-array.js';
import { DraftList } from './draft-list.js';
import { DraftMap } from './draft-map.js';
import { DraftSet } from './draft-set.js';
import { DraftOrderedMap } from './draft-ordered-map.js';
import { DraftOrderedSet } from './draft-ordered-set.js';

// Not a construct signature: the collections' constructors are private.
type Ctor = Function & { readonly prototype: object };

/** A type whose instances carry `[interned]`: valsem returns them as they are. */
export interface ValueTypeEntry {
  readonly name: string;
  readonly type: Ctor;
  /** A small instance, non-empty where that means anything. */
  readonly sample: () => object;
  /**
   * Whether equal content is one instance. False for RawArray alone, which is
   * a value by IDENTITY (two views over equal JSON are two values).
   */
  readonly byContent: boolean;
}

/** The persistent collections: the value types that hold other values and are iterable. */
export interface CollectionEntry extends ValueTypeEntry {
  readonly draftType: Ctor;
  /** A map: every item is stored as a key AND as that key's value. */
  readonly keyed: boolean;
  /** Order is part of the value: `of(a, b)` and `of(b, a)` are different values. */
  readonly ordered: boolean;
  /** Members are distinct: adding one that is already there is not a change. False for the list. */
  readonly distinct: boolean;
  readonly empty: () => object;
  /** The collection holding `items`, built by its bulk factory. */
  readonly of: (...items: unknown[]) => object;
  /** The same, built one persistent operation at a time from empty. */
  readonly chained: (...items: unknown[]) => object;
  /** Everything stored, read back out (a map's keys, then its values). */
  readonly contents: (c: object) => unknown[];
  readonly has: (c: object, item: unknown) => boolean;
  /** `c` with `item` added by the persistent operation (set, add, push). */
  readonly add: (c: object, item: unknown) => object;
  /** The same edit on the collection's draft, inside a recipe. */
  readonly draftAdd: (draft: object, item: unknown) => void;
  /** Every iterator the type hands out, by name. */
  readonly iterators: (c: object) => [string, IteratorObject<unknown, unknown, unknown>][];
}

const pairs = (items: unknown[]): [unknown, unknown][] => items.map((x) => [x, x]);

type AnyMap = ValueMap<unknown, unknown> | OrderedMap<unknown, unknown>;
type AnySet = ValueSet<unknown> | OrderedSet<unknown>;
type AnyDraftMap = DraftMap<unknown, unknown> | DraftOrderedMap<unknown, unknown>;
type AnyDraftSet = DraftSet<unknown> | DraftOrderedSet<unknown>;

const mapEntry = (
  name: string,
  type: typeof ValueMap | typeof OrderedMap,
  draftType: Ctor,
  ordered: boolean,
): CollectionEntry => ({
  name,
  type,
  draftType,
  keyed: true,
  ordered,
  distinct: true,
  byContent: true,
  sample: () => type.from([['k', 1]]),
  empty: () => type.empty(),
  of: (...items) => type.from(pairs(items)),
  chained: (...items) => items.reduce<AnyMap>((m, x) => m.set(x, x), type.empty<unknown, unknown>()),
  contents: (c) => [...(c as AnyMap).keys(), ...(c as AnyMap).values()],
  has: (c, item) => (c as AnyMap).has(item),
  add: (c, item) => (c as AnyMap).set(item, item),
  draftAdd: (d, item) => void (d as AnyDraftMap).set(item, item),
  iterators: (c) => {
    const m = c as AnyMap;
    return [['keys()', m.keys()], ['values()', m.values()], ['entries()', m.entries()], ['[Symbol.iterator]()', m[Symbol.iterator]()]];
  },
});

const setEntry = (
  name: string,
  type: typeof ValueSet | typeof OrderedSet,
  draftType: Ctor,
  ordered: boolean,
): CollectionEntry => ({
  name,
  type,
  draftType,
  keyed: false,
  ordered,
  distinct: true,
  byContent: true,
  sample: () => type.from([1]),
  empty: () => type.empty(),
  of: (...items) => type.from(items),
  chained: (...items) => items.reduce<AnySet>((s, x) => s.add(x), type.empty<unknown>()),
  contents: (c) => [...(c as AnySet)],
  has: (c, item) => (c as AnySet).has(item),
  add: (c, item) => (c as AnySet).add(item),
  draftAdd: (d, item) => void (d as AnyDraftSet).add(item),
  iterators: (c) => {
    const s = c as AnySet;
    return [['keys()', s.keys()], ['values()', s.values()], ['entries()', s.entries()], ['[Symbol.iterator]()', s[Symbol.iterator]()]];
  },
});

const listEntry: CollectionEntry = {
  name: 'ValueList',
  type: ValueList,
  draftType: DraftList,
  keyed: false,
  ordered: true,
  distinct: false,
  byContent: true,
  sample: () => ValueList.of(1, 2),
  empty: () => ValueList.empty(),
  of: (...items) => ValueList.from(items),
  chained: (...items) => items.reduce<ValueList<unknown>>((l, x) => l.push(x), ValueList.empty<unknown>()),
  contents: (c) => [...(c as ValueList<unknown>)],
  // A list has no membership probe of its own; this is "some element is the canonical `item`".
  has: (c, item) => (c as ValueList<unknown>).toArray().includes(intern(item)),
  add: (c, item) => (c as ValueList<unknown>).push(item),
  draftAdd: (d, item) => void (d as DraftList<unknown>).push(item),
  iterators: (c) => {
    return [['[Symbol.iterator]()', (c as ValueList<unknown>)[Symbol.iterator]()]];
  },
};

/** The persistent collections. */
export const COLLECTIONS: readonly CollectionEntry[] = [
  listEntry,
  mapEntry('ValueMap', ValueMap, DraftMap, false),
  setEntry('ValueSet', ValueSet, DraftSet, false),
  mapEntry('OrderedMap', OrderedMap, DraftOrderedMap, true),
  setEntry('OrderedSet', OrderedSet, DraftOrderedSet, true),
];

/** Every value type: the collections, and the three leaves. */
export const VALUE_TYPES: readonly ValueTypeEntry[] = [
  ...COLLECTIONS,
  { name: 'ValueDate', type: ValueDate, sample: () => ValueDate.of(0), byContent: true },
  { name: 'InternedString', type: InternedString, sample: () => InternedString.for('text'), byContent: true },
  { name: 'RawArray', type: RawArray, sample: () => RawArray.from([{ id: 1 }, { id: 2 }]), byContent: false },
];
