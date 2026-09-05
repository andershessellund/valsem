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
// ---------------------------------------------------------------------------

import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { InternedString } from './interned-string.js';

// --- deterministic rng (mulberry32) ----------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

// --- leaves ----------------------------------------------------------------

// Full leaf domain: strings, integers, doubles (NaN, ±0, ±Infinity included),
// booleans, null, undefined, InternedString.
export const leaf: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constantFrom(NaN, -0, Infinity, -Infinity),
  fc.string({ maxLength: 4 }).map((s) => InternedString.for(s)),
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
  const coll: fc.WeightedArbitrary<unknown>[] = collections
    ? [
        {
          weight: 1,
          arbitrary: fc
            .array(fc.tuple(sub, sub), { maxLength: 3 })
            .map((es) => ValueMap.from(es)),
        },
        { weight: 1, arbitrary: fc.array(sub, { maxLength: 3 }).map((vs) => ValueSet.from(vs)) },
        { weight: 1, arbitrary: fc.array(sub, { maxLength: 4 }).map((vs) => ValueList.from(vs)) },
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
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof ValueMap) &&
    !(v instanceof ValueSet) &&
    !(v instanceof ValueList) &&
    !(v instanceof InternedString)
  );
}

/**
 * Deep-copy a plain-data tree, PRESERVING per-node frozenness.
 * `InternedString` leaves are kept by reference (canonical and immutable —
 * `structuredClone` would flatten them into plain records).
 *
 * Frozenness carries valsem's identity doctrine into the mirror: a frozen
 * node models a canonical, and mutations must copy-on-write it per slot
 * (canonicalization collapses equal objects, so "reference aliasing" of
 * canonicals is not representable — identity exists only where mutability
 * does). Unfrozen nodes are the caller's own objects and alias normally.
 */
export function mutableClone(v: unknown): unknown {
  if (v instanceof InternedString) return v;
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
