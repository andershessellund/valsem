import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { configureLimits } from './limits.js';
import { produce } from './produce.js';

/** A nested array `depth` levels deep: [[[...[leaf]...]]]. */
function nested(depth: number, leaf: unknown = 1): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

describe('decode-boundary depth limits', () => {
  it('honest depth is admitted; past the cap intern and deepHash teach', () => {
    expect(() => intern(nested(500))).not.toThrow();
    expect(() => deepHash(nested(500))).not.toThrow();
    expect(() => intern(nested(600))).toThrow(/maximum nesting depth \(512\)/);
    expect(() => deepHash(nested(600))).toThrow(/maximum nesting depth \(512\)/);
  });

  it('the guard resets after a rejection — the next admission is clean', () => {
    expect(() => intern(nested(600))).toThrow(/nesting depth/);
    expect(intern([1, [2]])).toBe(intern([1, [2]]));
    expect(() => deepHash(nested(600))).toThrow(/nesting depth/);
    expect(deepHash([1])).toBe(deepHash([1]));
  });

  it('the guard resets after MANY rejections — no per-rejection leak', () => {
    // A counter incremented outside its try/finally leaks +1 per cap hit;
    // after `cap` hits every call is over the cap. Hit the cap more times
    // than the cap itself, then admit values at the cap's exact edge.
    try {
      configureLimits({ maxDepth: 20 });
      const tooDeep = nested(30);
      for (let i = 0; i < 25; i++) expect(() => deepHash(tooDeep)).toThrow(/nesting depth/);
      for (let i = 0; i < 25; i++) expect(() => intern(tooDeep)).toThrow(/nesting depth/);
      for (let i = 0; i < 25; i++) {
        expect(() => produce(intern({ a: 1 }), (d) => void ((d as Record<string, unknown>).x = tooDeep)))
          .toThrow(/nesting depth/);
      }
      const edge = nested(20); // exactly the cap: still admissible
      expect(() => deepHash(edge)).not.toThrow();
      expect(() => intern(edge)).not.toThrow();
      expect(() => produce(intern({ a: 1 }), (d) => void ((d as Record<string, unknown>).x = nested(19))))
        .not.toThrow();
    } finally {
      configureLimits({ maxDepth: 512 });
    }
  });

  it('cyclic input gets the teaching error, not a bare stack overflow', () => {
    const cyc: Record<string, unknown> = { x: 1 };
    cyc['self'] = cyc;
    expect(() => intern(cyc)).toThrow(/cyclic input/);
    expect(() => deepHash(cyc)).toThrow(/cyclic input/);
    expect(() =>
      produce(intern({ a: 1 }), (d) => void ((d as Record<string, unknown>).c = cyc)),
    ).toThrow(/cyclic input/);
  });

  it('deepEqual is uncapped — it walks past the admission cap', () => {
    // 600 > the admission cap, and deepEqual walks it fine: no cap, so no
    // verdict change on honestly deep equal structures.
    expect(deepEqual(nested(600), nested(600))).toBe(true);
    expect(deepEqual(nested(600), nested(600, 2))).toBe(false);
  });

  it('deepEqual on raw cyclic input is an ordinary recursive walk (documented: admit first)', () => {
    const a: Record<string, unknown> = { n: 1 };
    a['self'] = a;
    const b: Record<string, unknown> = { n: 1 };
    b['self'] = b;
    // Not a teaching error — the documented contract is totality over
    // ADMITTED values; raw cycles overflow the stack like any recursive walk.
    expect(() => deepEqual(a, b)).toThrow(RangeError);
  });

  it('the cap is reconfigurable, both ways', () => {
    try {
      configureLimits({ maxDepth: 10 });
      expect(() => intern(nested(11))).toThrow(/maximum nesting depth \(10\)/);
      configureLimits({ maxDepth: 2000 });
      expect(() => intern(nested(600))).not.toThrow();
    } finally {
      configureLimits({ maxDepth: 512 });
    }
  });

  it('rejects a non-positive or fractional cap', () => {
    expect(() => configureLimits({ maxDepth: 0 })).toThrow(/positive integer/);
    expect(() => configureLimits({ maxDepth: 1.5 })).toThrow(/positive integer/);
    expect(() => configureLimits({})).not.toThrow();
  });
});
