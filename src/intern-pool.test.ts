// The weak-pool machinery: bucket records on the global sweep circle.
//
// Structural invariants (linkage, slot accounting, collision promotion and
// demotion) are deterministic; reclamation tests need real GC and skip
// themselves when globalThis.gc is unavailable (vitest.config.ts passes
// --expose-gc to workers, so normally they run).
import { describe, it, expect } from 'vitest';
import { createInternPool, _sweepNow, _circleState } from './intern-pool.js';
import { equals, hashCode, interned } from './deep-equal.js';

const gc = (globalThis as { gc?: () => void }).gc;
const hasGC = typeof gc === 'function';

/**
 * Repeated gc + macrotask turns until `cond` holds (or rounds run out).
 *
 * The job boundary BEFORE gc() is essential: `WeakRef.deref()` (which the
 * condition typically performs, via size()/sweeps) puts its target on the
 * agent's [[KeptAlive]] list until the current job ends, so a gc() in the
 * same job treats every deref'd object as a root. The turns after gc() let
 * FinalizationRegistry callbacks land (they run as their own post-GC tasks).
 */
async function collectUntil(cond: () => boolean, rounds = 20): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await new Promise((r) => setImmediate(r));
    gc!();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  return cond();
}

class Point {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;
  constructor(
    readonly x: number,
    readonly y: number,
  ) {
    (this as Record<symbol, unknown>)[hashCode as unknown as symbol] =
      ((x * 73856093) ^ (y * 19349663)) >>> 0;
  }
  [equals](other: unknown): boolean {
    return other instanceof Point && other.x === this.x && other.y === this.y;
  }
}

describe('InternPool — canonicality', () => {
  it('intern() collapses equal instances to one ===', () => {
    const pool = createInternPool<Point>();
    const a = pool.intern(new Point(1, 2));
    const b = pool.intern(new Point(1, 2));
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect((a as Record<symbol, unknown>)[interned as unknown as symbol]).toBe(true);
    expect(pool.intern(new Point(3, 4))).not.toBe(a);
  });

  it('lookup/register honors predicates within one bucket (forced collision)', () => {
    const pool = createInternPool<{ v: number }>();
    const a = pool.register({ v: 1 }, 42);
    const b = pool.register({ v: 2 }, 42); // same hash — promotes to an array
    const c = pool.register({ v: 3 }, 42);
    expect(pool.lookup(42, (x) => x.v === 1)).toBe(a);
    expect(pool.lookup(42, (x) => x.v === 2)).toBe(b);
    expect(pool.lookup(42, (x) => x.v === 3)).toBe(c);
    expect(pool.lookup(42, (x) => x.v === 4)).toBeUndefined();
    expect(pool.lookup(7, () => true)).toBeUndefined();
    expect(pool.size()).toBe(3);
  });
});

describe('InternPool — circle invariants', () => {
  it('registrations link records; linkage stays valid; slots are accounted', () => {
    const before = _circleState(); // validates linkage as a side effect
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    for (let i = 0; i < 100; i++) held.push(pool.register({ v: i }, i));
    const after = _circleState();
    expect(after.records - before.records).toBe(100);
    expect(after.slots - before.slots).toBe(100);
    expect(held.length).toBe(100);
  });

  it('a collision bucket is one record with several slots', () => {
    const before = _circleState();
    const pool = createInternPool<{ v: number }>();
    const held = [pool.register({ v: 1 }, 5), pool.register({ v: 2 }, 5), pool.register({ v: 3 }, 5)];
    const after = _circleState();
    expect(after.records - before.records).toBe(1);
    expect(after.slots - before.slots).toBe(3);
    expect(held.length).toBe(3);
  });
});

describe.skipIf(!hasGC)('InternPool — reclamation (needs --expose-gc)', () => {
  it('sweeping removes dead members and their records', async () => {
    const pool = createInternPool<{ v: number }>();
    const before = _circleState();
    // Register in a callee so nothing on this frame retains the values.
    (function registerDoomed() {
      for (let i = 0; i < 200; i++) pool.register({ v: i }, 1_000_000 + i);
    })();
    const grown = _circleState();
    expect(grown.records - before.records).toBe(200);

    const cleaned = await collectUntil(() => {
      _sweepNow(10_000); // more than one full pass over everything in the circle
      return pool.size() === 0;
    });
    expect(cleaned).toBe(true);

    const swept = _circleState();
    expect(swept.records - before.records).toBeLessThanOrEqual(0);
    expect(swept.slots).toBeLessThanOrEqual(grown.slots - 200);
  });

  it('a dead singleton is replaced in place on re-registration (record reused)', async () => {
    const pool = createInternPool<{ v: number }>();
    (function registerDoomed() {
      pool.register({ v: 1 }, 77);
    })();
    expect(await collectUntil(() => pool.size() === 0)).toBe(true);

    const before = _circleState();
    const fresh = pool.register({ v: 2 }, 77);
    const after = _circleState();
    // Normally the dead singleton's record is reused in place (delta 0); a
    // backstop slice during collection may have already removed it (delta 1).
    expect(after.records - before.records).toBeLessThanOrEqual(1);
    expect(pool.lookup(77, (x) => x.v === 2)).toBe(fresh);
    expect(pool.size()).toBe(1);
  });

  it('survivors stay canonical across sweeps', async () => {
    const pool = createInternPool<Point>();
    const keep = pool.intern(new Point(9, 9));
    (function registerDoomed() {
      for (let i = 0; i < 100; i++) pool.intern(new Point(i, 1000));
    })();
    const cleaned = await collectUntil(() => {
      _sweepNow(10_000);
      return pool.size() === 1;
    });
    expect(cleaned).toBe(true);
    expect(pool.intern(new Point(9, 9))).toBe(keep);
  });

  it('the GC-epoch backstop reclaims without any pool traffic', async () => {
    expect(_circleState().backstopArmed).toBe(true);
    const pool = createInternPool<{ v: number }>();
    (function registerDoomed() {
      for (let i = 0; i < 500; i++) pool.register({ v: i }, 2_000_000 + i);
    })();
    const grown = _circleState();

    // No further pool operations: only GC epochs may clean. The backstop
    // sweeps a bounded slice per epoch, so allow several rounds.
    const cleaned = await collectUntil(() => _circleState().slots < grown.slots);
    expect(cleaned).toBe(true);
  });
});
