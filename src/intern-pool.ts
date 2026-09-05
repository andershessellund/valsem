// ---------------------------------------------------------------------------
// intern-pool — weak pools; the engine reports deaths, idle time buries them.
//
// A pool is a Map<hash, bucket>; a bucket is one Slot (the overwhelmingly
// common singleton case under a seeded 32-bit hash) or an array on a
// genuine collision. A Slot IS the WeakRef to the pooled object, carrying
// its hash and a shared WeakRef to the owning bucket map — one allocation
// per registration, and the registry's holdings are the slot itself.
//
// Cleanup is driven by ONE global FinalizationRegistry: a pooled object's
// death is reported once, by the engine, after the major GC that clears
// its WeakRef (the only time anything can be dead — scavenges never clear
// WeakRefs). The callback does the minimum — push the slot on a stack —
// and the actual bucket surgery runs when the thread is otherwise idle:
//
//   * requestIdleCallback where it exists (browser windows): the work lands
//     in time the host has declared worthless, in deadline-bounded slices;
//   * else setImmediate (Node, Bun): bounded slices, one per event-loop
//     turn, so a large post-GC batch never becomes one long task;
//   * else no deferral — the slot is reclaimed inside the callback.
//
// The stack is bounded (MAX_PENDING); past the bound, deaths are reclaimed
// inline until idle time drains it. Order is irrelevant — every reclaim is
// independent — so LIFO push/pop is the cheapest correct structure.
//
// What this replaced: an incremental sweeper that walked every pool's
// buckets in bounded slices on a registration-driven schedule. Measured end
// to end (frame-loop, pool churn, and collection benchmarks, on V8 and JSC),
// that schedule did nothing between major GCs — nothing was ever dead — and
// its per-registration tax was the only thing it reliably delivered.
//
// Requires WeakRef and FinalizationRegistry (ES2021; every supported
// runtime ships both).
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';

/** A pooled member: the WeakRef itself, plus what reclaiming it needs. */
class Slot extends WeakRef<object> {
  constructor(
    target: object,
    readonly hash: number,
    /** Shared WeakRef to the owning pool's bucket map — a dropped pool is not retained by its dying members. */
    readonly owner: WeakRef<Map<number, Bucket>>,
  ) {
    super(target);
  }
}

type Bucket = Slot | Slot[];

/** Remove a dead slot from its bucket. Idempotent: tolerates "already pruned". */
function reclaim(slot: Slot): void {
  const buckets = slot.owner.deref();
  if (buckets === undefined) return; // the pool itself is gone
  const b = buckets.get(slot.hash);
  if (b === undefined) return;
  if (b === slot) {
    buckets.delete(slot.hash);
  } else if (Array.isArray(b)) {
    const i = b.indexOf(slot);
    if (i >= 0) b.splice(i, 1);
    if (b.length === 1) buckets.set(slot.hash, b[0]!);
    else if (b.length === 0) buckets.delete(slot.hash);
  }
}

// ---------------------------------------------------------------------------
// Deferred reclamation
// ---------------------------------------------------------------------------

const MAX_PENDING = 100_000; // slots parked for idle time before deaths are reclaimed inline
const IMMEDIATE_SLICE = 4096; // slots per setImmediate turn (~0.5 ms)
const IDLE_MIN_SLICE = 64; // always make progress, even on a zero-remaining deadline

/** Dead slots awaiting idle time. LIFO — reclaims are independent, order is free. */
const pending: Slot[] = [];
let scheduled = false;

// Structural globalThis access: this module compiles against neither the
// DOM nor the Node ambient globals. Looked up at schedule time, not import
// time — one typeof per drain, and a test can install a fake.
interface IdleDeadline {
  timeRemaining(): number;
}
const _g = globalThis as {
  requestIdleCallback?: (cb: (deadline: IdleDeadline) => void) => unknown;
  setImmediate?: (cb: () => void) => unknown;
};

function canDefer(): boolean {
  return typeof _g.requestIdleCallback === 'function' || typeof _g.setImmediate === 'function';
}

function schedule(): void {
  if (scheduled) return;
  if (typeof _g.requestIdleCallback === 'function') {
    scheduled = true;
    _g.requestIdleCallback(drainIdle);
  } else if (typeof _g.setImmediate === 'function') {
    scheduled = true;
    _g.setImmediate(drainImmediate);
  }
}

function drainIdle(deadline: IdleDeadline): void {
  scheduled = false;
  let n = 0;
  while (pending.length > 0 && (n < IDLE_MIN_SLICE || deadline.timeRemaining() > 1)) {
    reclaim(pending.pop()!);
    n++;
  }
  if (pending.length > 0) schedule();
}

function drainImmediate(): void {
  scheduled = false;
  for (let n = 0; n < IMMEDIATE_SLICE && pending.length > 0; n++) reclaim(pending.pop()!);
  if (pending.length > 0) schedule();
}

// The registry must be reachable from a module-level binding: an
// unreferenced FinalizationRegistry is itself collected and its callbacks
// silently stop (measured, not theorized).
const registry = new FinalizationRegistry<Slot>((slot) => {
  if (pending.length >= MAX_PENDING || !canDefer()) {
    reclaim(slot);
    return;
  }
  pending.push(slot);
  schedule();
});

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * A typed, weakly-held pool of canonical instances of `T`.
 *
 * Members are retained via `WeakRef` and leave the pool once nothing else
 * references them: the engine reports each death after the major GC that
 * collects it, and the pool's bookkeeping is reclaimed in idle time (see the
 * module header). This backs the persistent
 * {@link ValueList}/{@link ValueMap}/{@link ValueSet}/{@link InternedString}
 * collections and any consumer value type (see {@link createInternPool}).
 *
 * The high-level entry point is {@link InternPool.intern}; the lower-level
 * {@link InternPool.lookup}/{@link InternPool.register} pair is for callers that
 * compute the hash and allocate the instance themselves.
 *
 * @typeParam T - The object type of the pooled canonical instances.
 */
export interface InternPool<T extends object> {
  /**
   * Look up an existing canonical instance with the given hash whose
   * structural content matches the predicate. Returns the canonical
   * instance, or `undefined` if no match is found (caller must allocate
   * and {@link register} a fresh instance).
   */
  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined;

  /**
   * Register a freshly-allocated instance with its hash. The instance is
   * weakly retained; once unreferenced elsewhere it will be GC'd and its
   * pool metadata reclaimed.
   */
  register(value: T, hash: number): T;

  /**
   * Intern `object` using its own `[hashCode]` and `[equals]` symbols.
   *
   * On a cache hit the canonical instance is returned and `object` is
   * discarded (no allocation committed). On a miss `object` is frozen,
   * marked `[interned]=true`, registered, and returned as the new
   * canonical instance.
   *
   * The object must have `[hashCode]: number` set before calling this.
   */
  intern(object: T): T;

  /** @internal Live pool size (walks all buckets) — exposed for tests. */
  size(): number;
}

class InternPoolImpl<T extends object> implements InternPool<T> {
  readonly #buckets = new Map<number, Bucket>();
  readonly #owner = new WeakRef(this.#buckets); // ONE shared WeakRef per pool

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const b = this.#buckets.get(hash);
    if (b === undefined) return undefined;
    if (Array.isArray(b)) {
      for (const slot of b) {
        const candidate = slot.deref();
        if (candidate !== undefined && predicate(candidate as T)) return candidate as T;
      }
      return undefined;
    }
    const candidate = b.deref();
    return candidate !== undefined && predicate(candidate as T) ? (candidate as T) : undefined;
  }

  register(value: T, hash: number): T {
    const slot = new Slot(value, hash, this.#owner);
    registry.register(value, slot);
    const b = this.#buckets.get(hash);
    if (b === undefined) {
      this.#buckets.set(hash, slot);
    } else if (Array.isArray(b)) {
      // Prune dead members in passing (their reclaim may still be pending), then append.
      let w = 0;
      for (let r = 0; r < b.length; r++) if (b[r]!.deref() !== undefined) b[w++] = b[r]!;
      b.length = w;
      b.push(slot);
    } else if (b.deref() === undefined) {
      this.#buckets.set(hash, slot); // replace the dead singleton in place
    } else {
      this.#buckets.set(hash, [b, slot]);
    }
    return value;
  }

  intern(object: T): T {
    if ((object as Record<symbol, unknown>)[internedSym] === true) return object;
    const hash = (object as Record<symbol, unknown>)[hashCodeSym] as number;
    const eq = (object as Record<symbol, unknown>)[equalsSym];
    const found = this.lookup(
      hash,
      (c) => typeof eq === 'function' && !!(eq as (other: unknown) => boolean).call(object, c),
    );
    if (found !== undefined) return found;
    (object as Record<symbol, unknown>)[internedSym] = true;
    Object.freeze(object);
    return this.register(object, hash);
  }

  size(): number {
    let n = 0;
    for (const b of this.#buckets.values()) {
      if (Array.isArray(b)) {
        for (const slot of b) if (slot.deref() !== undefined) n++;
      } else if (b.deref() !== undefined) {
        n++;
      }
    }
    return n;
  }

  /** @internal Test-only: bucket count, live or not (what reclaim shrinks). */
  _bucketCount(): number {
    return this.#buckets.size;
  }
}

/**
 * Create an empty {@link InternPool} for a value type `T`.
 *
 * Give a class its own pool to make its instances canonical (equal contents ⟹
 * `===`), the same way the built-in collections are. The pool holds its members
 * weakly, so canonical instances are reclaimed by GC once unreferenced. Because
 * a pool only ever holds one type, its hashes need no type tag to avoid
 * cross-type collisions.
 *
 * @typeParam T - The object type of the pooled canonical instances.
 * @returns A fresh, empty pool.
 *
 * @example
 * ```ts
 * const pool = createInternPool<Point>();
 *
 * class Point {
 *   declare readonly [hashCode]: number;
 *   declare readonly [interned]: true;
 *   private constructor(readonly x: number, readonly y: number) {}
 *   [equals](o: unknown) { return o instanceof Point && o.x === this.x && o.y === this.y; }
 *   static of(x: number, y: number): Point {
 *     const p = new Point(x, y);
 *     (p as any)[hashCode] = (x * 73856093) ^ (y * 19349663);
 *     return pool.intern(p); // frozen, marked interned, deduplicated
 *   }
 * }
 * ```
 */
export function createInternPool<T extends object>(): InternPool<T> {
  return new InternPoolImpl<T>();
}

// ---------------------------------------------------------------------------
// Test-only inspection hooks (not exported from the package barrel)
// ---------------------------------------------------------------------------

/** @internal Test-only: dead slots parked for idle time. */
export function _pendingCount(): number {
  return pending.length;
}

/** @internal Test-only: reclaim every parked slot now, synchronously. */
export function _drainNow(): number {
  const n = pending.length;
  while (pending.length > 0) reclaim(pending.pop()!);
  return n;
}

/** @internal Test-only: buckets in a pool, live or awaiting reclaim. */
export function _bucketCount(pool: InternPool<object>): number {
  return (pool as InternPoolImpl<object>)._bucketCount();
}

/** @internal Test-only: the stack bound. */
export const _MAX_PENDING = MAX_PENDING;
