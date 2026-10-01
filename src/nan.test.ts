// Every NaN is one value, whatever its bits — D22's sibling. A NaN carries a
// sign and a payload, and they are whatever the CPU left there: 0/0 is fff8…
// on x86-64 and 7ff8… on arm64, the literal is 7ff8…, and V8 keeps the bits
// wherever it stores the number. `===` denies even the literal to itself, so
// `Object.is`, `same` and `deepEqual` are the comparisons, and the hash has
// to agree with them (the companion invariant, DESIGN.md §3.2): one hash, one
// canonical, one member, one memo entry, whichever spelling arrived.
import { describe, it, expect } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern, isCanonical, fastEqual } from './intern.js';
import { HashMap } from './hash-map.js';
import { HashSet } from './hash-set.js';
import { memoize } from './memoize.js';
import { produce } from './produce.js';
import { COLLECTIONS } from './roster.test-helpers.js';

/** A NaN with the sign bit set: what `-NaN`, and 0/0 on x86-64, give. */
const negNaN = new Float64Array(new Uint32Array([0, 0xfff80000]).buffer)[0]!;
const bits = (x: number): string => {
  const f = new Float64Array([x]);
  const u = new Uint32Array(f.buffer);
  return u[1]!.toString(16).padStart(8, '0') + u[0]!.toString(16).padStart(8, '0');
};

describe('every NaN is one value', () => {
  it('the two spellings differ in their bits, and nowhere else', () => {
    expect(bits(negNaN)).not.toBe(bits(NaN));
    expect(Number.isNaN(negNaN)).toBe(true);
    expect(deepEqual(NaN, negNaN)).toBe(true);
    expect(isCanonical(negNaN)).toBe(true);
    // fastEqual is deepEqual made fast by canonicality: the one place `===` disagrees with deepEqual is covered.
    expect(fastEqual(NaN, NaN)).toBe(true);
    expect(fastEqual(NaN, negNaN)).toBe(true);
    expect(fastEqual(intern([NaN]), intern([negNaN]))).toBe(true);
  });

  it('deepHash: equal ⟹ same hash, for every spelling, bare and nested', () => {
    expect(deepHash(negNaN)).toBe(deepHash(NaN));
    expect(deepHash({ mean: negNaN })).toBe(deepHash({ mean: NaN }));
    expect(deepHash([1, negNaN])).toBe(deepHash([1, NaN]));
  });

  it('intern: one canonical, whichever spelling came first', () => {
    expect(intern({ mean: negNaN })).toBe(intern({ mean: NaN }));
    expect(intern([negNaN])).toBe(intern([NaN]));
    expect(deepEqual(intern({ mean: negNaN }), intern({ mean: NaN }))).toBe(true);
  });

  it('produce: an edit from one spelling to the other nets out', () => {
    const base = intern({ mean: NaN });
    expect(produce(base, (d) => void (d.mean = negNaN))).toBe(base);
  });

  for (const c of COLLECTIONS) {
    it(`${c.name}: found under either spelling, and one value whatever the order or the way it was built`, () => {
      const a = c.of(NaN, negNaN);
      expect(c.of(negNaN, NaN)).toBe(a);
      expect(c.chained(NaN, negNaN)).toBe(a);
      expect(c.has(a, negNaN)).toBe(true);
      expect(c.has(a, NaN)).toBe(true);
      expect(c.has(c.of(negNaN), NaN)).toBe(true);
    });
  }

  it('HashMap, HashSet and memoize key by the value, not the bits', () => {
    const hm = new HashMap([[{ score: NaN }, 'row']]);
    expect(hm.get({ score: negNaN })).toBe('row');
    expect(new HashSet([negNaN]).has(NaN)).toBe(true);
    let runs = 0;
    const f = memoize((x: { score: number }) => { runs++; return x.score; });
    f({ score: NaN });
    f({ score: negNaN });
    expect(runs).toBe(1);
  });
});
