// ---------------------------------------------------------------------------
// Shared fast-check arbitraries and structural-clone machinery for the
// property suites. Excluded from the build (tsconfig `*.test-helpers.ts`).
//
// The central device is `shuffledClone`: an *independently built* structural
// equal of a value tree — records rebuilt with shuffled key-insertion order,
// collections rebuilt from shuffled entries via randomly chosen construction
// paths (from() vs op chains, with occasional add-then-delete detours). Every
// equality/canonicality property tests against these derived equals, because
// random unrelated pairs are almost never equal.
//
// The domain is every kind of value valsem has: a law stated over `valueTree`
// is only as wide as this file. A new value type belongs in `leaf` or in
// `containerArb`, and in `shuffledClone`.
// ---------------------------------------------------------------------------

import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { InternedString } from './interned-string.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { ValueDate } from './value-date.js';
import { RawArray } from './raw-array.js';
import { shuffle } from './rng.test-helpers.js';

// --- leaves ----------------------------------------------------------------

// A unique symbol is a value by identity, and so is a RawArray: a tree can only
// hold "the same one" if the generator draws from a fixed few.
const UNIQUE_SYMBOLS = [Symbol('valsem.prop.u1'), Symbol('valsem.prop.u2')];
const RAW_ARRAYS = [RawArray.from([{ id: 1 }, { id: 2 }]), RawArray.from([{ id: 1 }, { id: 2 }])]; // equal JSON, two values

// Full leaf domain: strings, integers, doubles (NaN, ±0, ±Infinity included),
// booleans, null, undefined, bigints, symbols (registered, unique and
// well-known), and the three leaf value types: InternedString, ValueDate,
// RawArray.
export const leaf: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 8 }) },
  { weight: 3, arbitrary: fc.integer() },
  { weight: 2, arbitrary: fc.double() },
  { weight: 2, arbitrary: fc.boolean() },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constantFrom(NaN, -0, Infinity, -Infinity) },
  { weight: 1, arbitrary: fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }) },
  { weight: 1, arbitrary: fc.constantFrom(Symbol.for('valsem.prop.a'), Symbol.for('valsem.prop.b'), Symbol.iterator, ...UNIQUE_SYMBOLS) },
  { weight: 1, arbitrary: fc.string({ maxLength: 4 }).map((s) => InternedString.for(s)) },
  { weight: 1, arbitrary: fc.integer({ min: -8.64e15, max: 8.64e15 }).map((ms) => ValueDate.from(ms)) },
  { weight: 1, arbitrary: fc.constantFrom(...RAW_ARRAYS) },
);

const recordKey = fc
  .oneof(fc.constantFrom('a', 'b', 'c', 'd'), fc.string({ maxLength: 6 }))
  .filter((k) => k !== '__proto__');

// --- trees -----------------------------------------------------------------

function containerArb(sub: fc.Arbitrary<unknown>, collections: boolean): fc.Arbitrary<unknown> {
  const plain: fc.WeightedArbitrary<unknown>[] = [
    { weight: 3, arbitrary: fc.array(sub, { maxLength: 4 }) },
    { weight: 3, arbitrary: fc.dictionary(recordKey, sub, { maxKeys: 4, noNullPrototype: true }) },
  ];
  const pairs = (max: number, of: fc.Arbitrary<unknown>): fc.Arbitrary<[unknown, unknown][]> => fc.array(fc.tuple(of, of), { maxLength: max });
  const coll: fc.WeightedArbitrary<unknown>[] = collections
    ? [
        { weight: 1, arbitrary: pairs(3, sub).map((es) => ValueMap.from(es)) },
        { weight: 1, arbitrary: fc.array(sub, { maxLength: 3 }).map((vs) => ValueSet.from(vs)) },
        { weight: 1, arbitrary: fc.array(sub, { maxLength: 4 }).map((vs) => ValueList.from(vs)) },
        { weight: 1, arbitrary: pairs(3, sub).map((es) => OrderedMap.from(es)) },
        { weight: 1, arbitrary: fc.array(sub, { maxLength: 3 }).map((vs) => OrderedSet.from(vs)) },
        // Wide and flat: past one trie node and one list run (MAX_RUN is 64),
        // where the small ones above never get. Leaves only, to stay cheap.
        {
          weight: 1,
          arbitrary: fc.oneof(
            pairs(90, leaf).map((es) => ValueMap.from(es)),
            fc.array(leaf, { maxLength: 90 }).map((vs) => ValueSet.from(vs)),
            fc.array(leaf, { maxLength: 150 }).map((vs) => ValueList.from(vs)),
            pairs(90, leaf).map((es) => OrderedMap.from(es)),
            fc.array(leaf, { maxLength: 90 }).map((vs) => OrderedSet.from(vs)),
          ),
        },
      ]
    : [];
  return fc.oneof({ withCrossShrink: true }, { weight: 4, arbitrary: leaf }, ...plain, ...coll);
}

function treeArb(depth: number, collections: boolean): fc.Arbitrary<unknown> {
  if (depth === 0) return leaf;
  return containerArb(treeArb(depth - 1, collections), collections);
}

/** Arbitrary value trees over the full domain, collections included. */
export const valueTree = treeArb(3, true);

/** Plain-data trees only (records/arrays/leaves) — the produce-draft domain. */
export const plainTree = treeArb(3, false);

// --- independently built structural equals ---------------------------------

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a plain-data tree, PRESERVING per-node frozenness.
 * The leaf value types (`InternedString`, `ValueDate`, `RawArray`) are kept by
 * reference (canonical and immutable — `structuredClone` would flatten them
 * into plain records).
 *
 * Frozenness carries valsem's identity doctrine into the mirror: a frozen
 * node models a canonical, and mutations must copy-on-write it per slot
 * (canonicalization collapses equal objects, so "reference aliasing" of
 * canonicals is not representable — identity exists only where mutability
 * does). Unfrozen nodes are the caller's own objects and alias normally.
 */
export function mutableClone(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = v.map(mutableClone);
    return Object.isFrozen(v) ? Object.freeze(out) : out;
  }
  if (isPlainRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = mutableClone(v[k]);
    return Object.isFrozen(v) ? Object.freeze(out) : out;
  }
  return v;
}

/**
 * Rebuild `v` from scratch as an independent object graph that must be
 * `deepEqual` — shuffled record-key insertion order, shuffled collection
 * entry order, randomly chosen construction paths, occasional
 * add-then-delete detours (history independence).
 */
export function shuffledClone(v: unknown, rnd: () => number): unknown {
  if (v instanceof InternedString) return InternedString.for(v.value);
  if (v instanceof ValueDate) return rnd() < 0.5 ? ValueDate.from(v.valueOf()) : ValueDate.from(v.toDate());
  if (v instanceof RawArray) return v; // a value by identity: its only equal is itself
  if (typeof v === 'bigint') return BigInt(v.toString());
  if (v instanceof OrderedMap) {
    const entries = [...(v as OrderedMap<unknown, unknown>).entries()].map(
      ([k, val]) => [shuffledClone(k, rnd), shuffledClone(val, rnd)] as const,
    );
    return orderedRebuild(
      entries,
      rnd,
      (es) => OrderedMap.from(es),
      OrderedMap.empty<unknown, unknown>(),
      (m, [k, val]) => m.set(k, val),
      (m, i, [k, val]) => m.insertAt(i, k, val),
      (m, spare) => (m.has(spare) ? m : m.set(spare, 0).delete(spare)),
    );
  }
  if (v instanceof OrderedSet) {
    const items = [...(v as OrderedSet<unknown>)].map((x) => shuffledClone(x, rnd));
    return orderedRebuild(
      items,
      rnd,
      (xs) => OrderedSet.from(xs),
      OrderedSet.empty<unknown>(),
      (s, x) => s.add(x),
      (s, i, x) => s.insertAt(i, x),
      (s, spare) => (s.has(spare) ? s : s.add(spare).delete(spare)),
    );
  }
  if (v instanceof ValueMap) {
    const entries = shuffle(
      [...(v as ValueMap<unknown, unknown>).entries()].map(
        ([k, val]) => [shuffledClone(k, rnd), shuffledClone(val, rnd)] as const,
      ),
      rnd,
    );
    if (rnd() < 0.5) return ValueMap.from(entries);
    let m = ValueMap.empty<unknown, unknown>();
    for (const [k, val] of entries) m = m.set(k, val);
    if (rnd() < 0.3) {
      const spare = `spare_${Math.floor(rnd() * 1e9)}`;
      if (!m.has(spare)) m = m.set(spare, 0).delete(spare);
    }
    return m;
  }
  if (v instanceof ValueSet) {
    const items = shuffle(
      [...(v as ValueSet<unknown>).values()].map((x) => shuffledClone(x, rnd)),
      rnd,
    );
    if (rnd() < 0.5) return ValueSet.from(items);
    let s = ValueSet.empty<unknown>();
    for (const x of items) s = s.add(x);
    if (rnd() < 0.3) {
      const spare = `spare_${Math.floor(rnd() * 1e9)}`;
      if (!s.has(spare)) s = s.add(spare).delete(spare);
    }
    return s;
  }
  if (v instanceof ValueList) {
    const items = (v as ValueList<unknown>).toArray().map((x) => shuffledClone(x, rnd));
    if (rnd() < 0.5) return ValueList.from(items);
    let l = ValueList.empty<unknown>();
    for (const x of items) l = l.push(x);
    if (rnd() < 0.3) l = l.push('spare').pop();
    return l;
  }
  if (Array.isArray(v)) return v.map((x) => shuffledClone(x, rnd));
  if (isPlainRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of shuffle(Object.keys(v), rnd)) out[k] = shuffledClone(v[k], rnd);
    return out;
  }
  return v;
}

/**
 * An ordered collection holding `items` in THAT order, by one of three routes:
 * the bulk factory; appends from empty; or `insertAt` in a shuffled order,
 * each item going to the rank it has among those already in. Order is part
 * of the value, so unlike the unordered rebuilds this one must arrive at the
 * same sequence; only the history differs. Then, sometimes, a detour.
 */
function orderedRebuild<C, I>(
  items: readonly I[],
  rnd: () => number,
  from: (items: readonly I[]) => C,
  empty: C,
  append: (c: C, item: I) => C,
  insertAt: (c: C, index: number, item: I) => C,
  detour: (c: C, spare: string) => C,
): C {
  const route = rnd();
  let built: C;
  if (route < 0.34) built = from(items);
  else if (route < 0.67) built = items.reduce(append, empty);
  else {
    built = empty;
    const placed: number[] = []; // original indices already in, ascending
    for (const at of shuffle(items.map((_, i) => i), rnd)) {
      const rank = placed.filter((p) => p < at).length;
      built = insertAt(built, rank, items[at]!);
      placed.splice(rank, 0, at);
    }
  }
  return rnd() < 0.3 ? detour(built, `spare_${Math.floor(rnd() * 1e9)}`) : built;
}
