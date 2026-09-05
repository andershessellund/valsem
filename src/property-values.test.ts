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
import { leaf, mulberry32, shuffle, shuffledClone, valueTree } from './property.test-helpers.js';

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
        for (const [k, val] of shuffle([...m.entries()], rnd)) chained = chained.set(k, val);
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
        for (const x of items) chained = chained.push(x);
        expect(chained).toBe(l);
        expect(ValueList.from(l.toArray())).toBe(l);
        const flat = l.toArray();
        for (let i = 0; i < flat.length; i++) expect(l.get(i)).toBe(flat[i]);
        expect(l.push('x').pop()).toBe(l);
      }),
      { numRuns: 300 },
    );
  });
});
