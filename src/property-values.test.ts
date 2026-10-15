// ---------------------------------------------------------------------------
// Property suites: the companion invariant and intern canonicality.
//
// Design law #1 (companion invariant): deepEqual(a, b) ⟹ deepHash(a) ===
// deepHash(b). Canonicality: independently built structural equals intern to
// the same reference; interning is idempotent; collection canonical form is
// build-order and history independent. All tested against `shuffledClone`
// derived equals — random unrelated pairs are almost never equal, so the
// clone is where the invariant actually gets exercised.
// ---------------------------------------------------------------------------

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { createMarvin32Hasher } from './hasher.js';
import { leaf, shuffledClone, valueTree } from './property.test-helpers.js';
import { mulberry32, shuffle } from './rng.test-helpers.js';

const seedArb = fc.integer({ min: 0, max: 0x7fffffff });

describe('property — companion invariant', () => {
  it('independently built equals: deepEqual true, hashes agree', () => {
    fc.assert(
      fc.property(valueTree, seedArb, (v, seed) => {
        const c = shuffledClone(v, mulberry32(seed));
        expect(deepEqual(v, c)).toBe(true);
        expect(deepEqual(c, v)).toBe(true);
        expect(deepHash(v)).toBe(deepHash(c));
      }),
      { numRuns: 500 },
    );
  });

  it('unrelated pairs: hash disagreement implies inequality; equality implies hash agreement', () => {
    fc.assert(
      fc.property(valueTree, valueTree, (a, b) => {
        if (deepHash(a) !== deepHash(b)) expect(deepEqual(a, b)).toBe(false);
        if (deepEqual(a, b)) expect(deepHash(a)).toBe(deepHash(b));
      }),
      { numRuns: 500 },
    );
  });

  it('deepHash is stable across calls and across interning', () => {
    fc.assert(
      fc.property(valueTree, (v) => {
        const h = deepHash(v);
        expect(deepHash(v)).toBe(h);
        expect(deepHash(intern(v))).toBe(h);
      }),
      { numRuns: 200 },
    );
  });
});

// The same law under a hasher that is not the active one: the walk is a
// different one (nothing baked in is under this hasher), so it is tested
// as its own law, over the same domain, against the same derived equals.
describe('property — companion invariant under another hasher', () => {
  const h = createMarvin32Hasher(0x5eed_1234, 0x0000_abcd);
  const twin = createMarvin32Hasher(0x5eed_1234, 0x0000_abcd);
  const other = createMarvin32Hasher(0x0000_abcd, 0x5eed_1234);

  it('independently built equals hash alike under it, and as a twin of the same key hashes them', () => {
    fc.assert(
      fc.property(valueTree, seedArb, (v, seed) => {
        const c = shuffledClone(v, mulberry32(seed));
        expect(deepHash(v, h)).toBe(deepHash(c, h));
        expect(deepHash(c, twin)).toBe(deepHash(v, h));
      }),
      { numRuns: 500 },
    );
  });

  it('unrelated pairs: hash disagreement implies inequality; equality implies hash agreement', () => {
    fc.assert(
      fc.property(valueTree, valueTree, (a, b) => {
        if (deepHash(a, h) !== deepHash(b, h)) expect(deepEqual(a, b)).toBe(false);
        if (deepEqual(a, b)) expect(deepHash(a, h)).toBe(deepHash(b, h));
      }),
      { numRuns: 500 },
    );
  });

  it('is stable across calls and across interning, and is not the active hash, nor another key\'s', () => {
    // A value with no leaf to hash — null, undefined, a boolean, an empty
    // container — hashes to a tagged constant, the same under every hasher.
    // Everything else differs, with 32-bit probability, from the active hash
    // and from another key's.
    const hasContent = (v: unknown): boolean => {
      if (v === null || v === undefined || typeof v === 'boolean') return false;
      if (typeof v !== 'object') return true;
      if (Array.isArray(v)) return v.some(hasContent);
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto === Object.prototype || proto === null) return Object.values(v as object).some(hasContent);
      if (v instanceof ValueMap || v instanceof OrderedMap) return [...v].some(([k, x]) => hasContent(k) || hasContent(x));
      if (v instanceof ValueList || v instanceof ValueSet || v instanceof OrderedSet) return [...v].some(hasContent);
      return true; // a leaf value type: a number, a string, an identity
    };
    let coincidences = 0;
    fc.assert(
      fc.property(valueTree, (v) => {
        const u = deepHash(v, h);
        expect(deepHash(v, h)).toBe(u);
        expect(deepHash(intern(v), h)).toBe(u);
        if (!hasContent(v)) return;
        if (u === deepHash(v)) coincidences++;
        if (u === deepHash(v, other)) coincidences++;
      }),
      { numRuns: 300 },
    );
    expect(coincidences).toBe(0);
  });
});

describe('property — intern canonicality', () => {
  it('independently built equals collapse to one reference; interning is idempotent', () => {
    fc.assert(
      fc.property(valueTree, seedArb, (v, seed) => {
        const c = shuffledClone(v, mulberry32(seed));
        const iv = intern(v);
        expect(intern(c)).toBe(iv);
        expect(intern(iv)).toBe(iv);
        expect(deepEqual(iv, c)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

});

describe('property — collection canonical form', () => {
  it('ValueMap: rebuild from shuffled canonical entries is the same instance', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(leaf, leaf), { maxLength: 10 }), seedArb, (entries, seed) => {
        const m = ValueMap.from(entries);
        const rnd = mulberry32(seed);
        const rebuilt = ValueMap.from(shuffle([...m.entries()], rnd));
        expect(rebuilt).toBe(m);
        let chained = ValueMap.empty<unknown, unknown>();
        for (const [k, val] of shuffle([...m.entries()], rnd)) chained = chained.with(k, val);
        expect(chained).toBe(m);
      }),
      { numRuns: 300 },
    );
  });

  it('ValueSet: order and duplicates never matter', () => {
    fc.assert(
      fc.property(fc.array(leaf, { maxLength: 10 }), seedArb, (items, seed) => {
        const s = ValueSet.from(items);
        const doubled = shuffle([...items, ...items], mulberry32(seed));
        expect(ValueSet.from(doubled)).toBe(s);
      }),
      { numRuns: 300 },
    );
  });

  it('ValueList: from/push-chain/toArray round-trips; toArray()[i] === get(i)', () => {
    fc.assert(
      fc.property(fc.array(leaf, { maxLength: 12 }), (items) => {
        const l = ValueList.from(items);
        expect(l.length).toBe(items.length);
        let chained = ValueList.empty<unknown>();
        for (const x of items) chained = chained.pushed(x);
        expect(chained).toBe(l);
        expect(ValueList.from(l.toArray())).toBe(l);
        const flat = l.toArray();
        for (let i = 0; i < flat.length; i++) expect(l.get(i)).toBe(flat[i]);
        expect(l.pushed('x').popped()).toBe(l);
      }),
      { numRuns: 300 },
    );
  });
});
