// The weak-pool machinery: buckets, and deferred reclamation of dead slots.
//
// Bucket behaviour (collision promotion/demotion, pruning in passing) is
// deterministic. Reclamation needs real GC — the engine reports a death via
// FinalizationRegistry only after the major GC that clears the WeakRef —
// and those tests skip themselves when globalThis.gc is unavailable
// (vitest.config.ts passes --expose-gc to workers, so normally they run).
// The idle scheduler is exercised through a fake requestIdleCallback
// installed on globalThis; Node has none, so the shipped default here is
// setImmediate.
import { describe, it, expect, afterEach } from 'vitest';
import {
  createInternPool,
  _pendingCount,
  _drainNow,
  _bucketCount,
  _MAX_PENDING,
} from './intern-pool.js';
import { equals, hashCode, interned } from './deep-equal.js';

const gc = (globalThis as { gc?: () => void }).gc;
const hasGC = typeof gc === 'function';
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Repeated gc + macrotask turns until `cond` holds (or rounds run out).
 *
 * The job boundary BEFORE gc() is essential: `WeakRef.deref()` (which the
 * condition typically performs, via size()) puts its target on the agent's
 * [[KeptAlive]] list until the current job ends, so a gc() in the same job
 * treats every deref'd object as a root. The turns after gc() let the
 * FinalizationRegistry callback land (it runs as its own post-GC task) and
 * the setImmediate drain run after it.
 */
async function collectUntil(cond: () => boolean, rounds = 20): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await turn();
    gc!();
    await turn();
    await turn();
    await turn();
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

type G = { requestIdleCallback?: unknown; setImmediate?: unknown };
const g = globalThis as G;
const realSetImmediate = g.setImmediate;
afterEach(() => {
  delete g.requestIdleCallback;
  g.setImmediate = realSetImmediate;
  _drainNow();
});

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
    expect(_bucketCount(pool)).toBe(1);
  });

  it('one bucket per hash; size counts members', () => {
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    for (let i = 0; i < 100; i++) held.push(pool.register({ v: i }, i));
    expect(_bucketCount(pool)).toBe(100);
    expect(pool.size()).toBe(100);
    expect(held.length).toBe(100);
  });
});

describe.skipIf(!hasGC)('InternPool — reclamation (needs --expose-gc)', () => {
  it('dead members leave the pool and their buckets are reclaimed (setImmediate drain)', async () => {
    const pool = createInternPool<{ v: number }>();
    // Register in a callee so nothing on this frame retains the values.
    (function registerDoomed() {
      for (let i = 0; i < 200; i++) pool.register({ v: i }, 1_000_000 + i);
    })();
    expect(_bucketCount(pool)).toBe(200);
    const cleaned = await collectUntil(() => pool.size() === 0 && _bucketCount(pool) === 0);
    expect(cleaned).toBe(true);
    expect(_pendingCount()).toBe(0); // the drain ran; nothing left parked
  });

  it('deaths are parked for idle time when requestIdleCallback exists, and drained there', async () => {
    const idleCallbacks: Array<(d: { timeRemaining(): number }) => void> = [];
    g.requestIdleCallback = (cb: (d: { timeRemaining(): number }) => void) => {
      idleCallbacks.push(cb);
    };
    const pool = createInternPool<{ v: number }>();
    (function registerDoomed() {
      for (let i = 0; i < 300; i++) pool.register({ v: i }, 3_000_000 + i);
    })();
    // Wait for the deaths to be REPORTED (parked), not reclaimed: with a fake
    // rIC that never fires, buckets stay until we run the idle callback.
    const parked = await collectUntil(() => _pendingCount() >= 300);
    expect(parked).toBe(true);
    expect(pool.size()).toBe(0); // deref() is already undefined…
    expect(_bucketCount(pool)).toBe(300); // …but the bookkeeping waits for idle time
    expect(idleCallbacks.length).toBe(1); // scheduled once, not once per death

    // Idle time arrives, in a deadline-bounded slice.
    let budget = 2;
    idleCallbacks.shift()!({ timeRemaining: () => budget-- });
    expect(_bucketCount(pool)).toBeLessThan(300); // progress…
    expect(idleCallbacks.length).toBe(1); // …and rescheduled for the rest
    idleCallbacks.shift()!({ timeRemaining: () => 50 });
    expect(_bucketCount(pool)).toBe(0);
    expect(_pendingCount()).toBe(0);
  });

  it('with neither requestIdleCallback nor setImmediate, deaths are reclaimed inline', async () => {
    delete g.requestIdleCallback;
    g.setImmediate = undefined;
    try {
      const pool = createInternPool<{ v: number }>();
      (function registerDoomed() {
        for (let i = 0; i < 100; i++) pool.register({ v: i }, 4_000_000 + i);
      })();
      // Nothing can be parked, so the only way to zero buckets is inline reclaim.
      for (let round = 0; round < 20 && _bucketCount(pool) > 0; round++) {
        await new Promise((r) => (realSetImmediate as typeof setImmediate)(r));
        gc!();
        await new Promise((r) => (realSetImmediate as typeof setImmediate)(r));
        await new Promise((r) => (realSetImmediate as typeof setImmediate)(r));
      }
      expect(_bucketCount(pool)).toBe(0);
      expect(_pendingCount()).toBe(0);
    } finally {
      g.setImmediate = realSetImmediate;
    }
  });

  it('a dead singleton is replaced in place on re-registration, before or after its reclaim', async () => {
    const pool = createInternPool<{ v: number }>();
    (function registerDoomed() {
      pool.register({ v: 1 }, 77);
    })();
    expect(await collectUntil(() => pool.size() === 0)).toBe(true);
    const fresh = pool.register({ v: 2 }, 77);
    expect(_bucketCount(pool)).toBe(1);
    expect(pool.lookup(77, (x) => x.v === 2)).toBe(fresh);
    expect(pool.size()).toBe(1);
    // A late reclaim of the OLD slot must not evict the new member.
    _drainNow();
    expect(pool.lookup(77, (x) => x.v === 2)).toBe(fresh);
  });

  it('a collision bucket prunes dead members in passing and demotes to a singleton', async () => {
    g.requestIdleCallback = () => {}; // park deaths; never drain
    const pool = createInternPool<{ v: number }>();
    const keep = pool.register({ v: 0 }, 55);
    (function registerDoomed() {
      pool.register({ v: 1 }, 55);
      pool.register({ v: 2 }, 55);
    })();
    expect(await collectUntil(() => pool.size() === 1)).toBe(true);
    // Reclaims are parked; the next register into this bucket prunes anyway.
    const added = pool.register({ v: 3 }, 55);
    expect(pool.size()).toBe(2);
    expect(pool.lookup(55, (x) => x.v === 0)).toBe(keep);
    expect(pool.lookup(55, (x) => x.v === 3)).toBe(added);
    // Draining the stale reclaims afterwards is a no-op on the pruned bucket.
    _drainNow();
    expect(pool.size()).toBe(2);
    expect(_bucketCount(pool)).toBe(1);
  });

  it('survivors stay canonical across reclamation', async () => {
    const pool = createInternPool<Point>();
    const keep = pool.intern(new Point(9, 9));
    (function registerDoomed() {
      for (let i = 0; i < 100; i++) pool.intern(new Point(i, 1000));
    })();
    expect(await collectUntil(() => pool.size() === 1)).toBe(true);
    expect(pool.intern(new Point(9, 9))).toBe(keep);
  });

  it('a dropped pool is not retained by its dying members', async () => {
    let pool: ReturnType<typeof createInternPool<{ v: number }>> | null = createInternPool();
    (function registerDoomed() {
      for (let i = 0; i < 50; i++) pool!.register({ v: i }, 5_000_000 + i);
    })();
    pool = null; // the pool and its bucket map are now garbage too
    // Reclaims of its slots must not throw when the owner is gone.
    expect(await collectUntil(() => _pendingCount() === 0, 10)).toBe(true);
  });

  it('past the stack bound, deaths are reclaimed inline (memory stays bounded)', async () => {
    g.requestIdleCallback = () => {}; // idle never comes
    const pool = createInternPool<{ v: number }>();
    const N = _MAX_PENDING + 2_000;
    (function registerDoomed() {
      for (let i = 0; i < N; i++) pool.register({ v: i }, 6_000_000 + i);
    })();
    const reported = await collectUntil(() => _bucketCount(pool) <= N - 1_000, 40);
    expect(reported).toBe(true);
    // The stack filled to its bound; every death past it was reclaimed inline.
    expect(_pendingCount()).toBeLessThanOrEqual(_MAX_PENDING);
    expect(_bucketCount(pool)).toBeLessThanOrEqual(_MAX_PENDING);
    _drainNow();
    expect(_bucketCount(pool)).toBe(0);
  });
});
