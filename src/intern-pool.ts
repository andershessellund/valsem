// ---------------------------------------------------------------------------
// intern-pool — weak pools; the engine reports deaths, idle time buries them.
//
// A pool is a Map from a 30-bit key to a bucket: one Slot (the overwhelmingly
// common case) or an array when two slots share a key. A Slot IS the WeakRef
// to the pooled object, carrying its full 32-bit hash and its pool — one
// allocation per registration, and the registry's holdings are the slot
// itself.
//
// The key is `hash & 0x3fffffff`, not the full uint32: V8's Smi range under
// pointer compression is 31-bit signed, so three quarters of full hashes
// would be boxed HeapNumber keys, and Map hits at scale cost ~2× more that
// way (measured); on JavaScriptCore the masking is neutral. Slots of
// different full hashes can therefore share a bucket, so every candidate is
// pre-checked on `slot.hash` before it is dereferenced. A hand-rolled open
// hash table was measured against this and rejected: equal on V8 in every
// realistic regime, ~10 % slower where pools grow unboundedly (JS rebuilds
// against a native rehash), and clearly slower on JavaScriptCore.
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

/**
 * A pooled member: the WeakRef itself, plus what reclaiming it needs — the
 * full hash and the pool. The pool reference is strong on purpose: the
 * registry retains a slot only until its target dies, so a dropped pool is
 * retained exactly as long as its last live member — the members' own
 * lifetime, not a leak. Subclassing WeakRef (rather than wrapping one) was
 * measured: zero deoptimizations, identical deref/construction cost, and one
 * object header less per slot.
 */
class Slot extends WeakRef<object> {
  constructor(
    target: object,
    readonly hash: number,
    readonly pool: InternPoolImpl<object>,
  ) {
    super(target);
  }
}

type Bucket = Slot | Slot[];

/** Map key for a full 32-bit hash: the low 30 bits, always a Smi. */
const KEY_MASK = 0x3fffffff;

/** Remove a dead slot from its pool. Idempotent: tolerates "already pruned". */
function reclaim(slot: Slot): void {
  slot.pool._reclaim(slot);
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

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const b = this.#buckets.get(hash & KEY_MASK);
    if (b === undefined) return undefined;
    if (Array.isArray(b)) {
      for (let i = 0; i < b.length; i++) {
        const slot = b[i]!;
        if (slot.hash !== hash) continue; // shares the 30-bit key, not a candidate
        const candidate = slot.deref();
        if (candidate !== undefined && predicate(candidate as T)) return candidate as T;
      }
      return undefined;
    }
    if (b.hash !== hash) return undefined;
    const candidate = b.deref();
    return candidate !== undefined && predicate(candidate as T) ? (candidate as T) : undefined;
  }

  register(value: T, hash: number): T {
    const slot = new Slot(value, hash, this as unknown as InternPoolImpl<object>);
    registry.register(value, slot);
    const key = hash & KEY_MASK;
    const b = this.#buckets.get(key);
    if (b === undefined) {
      this.#buckets.set(key, slot);
    } else if (Array.isArray(b)) {
      // Prune dead members in passing (their reclaim may still be pending), then append.
      let w = 0;
      for (let r = 0; r < b.length; r++) if (b[r]!.deref() !== undefined) b[w++] = b[r]!;
      b.length = w;
      b.push(slot);
    } else if (b.deref() === undefined) {
      this.#buckets.set(key, slot); // replace the dead singleton in place
    } else {
      this.#buckets.set(key, [b, slot]);
    }
    return value;
  }

  /** @internal Remove `slot` if it is still in its bucket. Idempotent. */
  _reclaim(slot: Slot): void {
    const key = slot.hash & KEY_MASK;
    const b = this.#buckets.get(key);
    if (b === slot) {
      this.#buckets.delete(key);
    } else if (Array.isArray(b)) {
      const k = b.indexOf(slot);
      if (k < 0) return; // already pruned in passing
      b.splice(k, 1);
      if (b.length === 1) this.#buckets.set(key, b[0]!);
    }
    // else: replaced in place by a live member — nothing to do
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
        for (let k = 0; k < b.length; k++) if (b[k]!.deref() !== undefined) n++;
      } else if (b.deref() !== undefined) {
        n++;
      }
    }
    return n;
  }

  /** @internal Test-only: slots stored (live or awaiting reclaim), and bucket count. */
  _stats(): { slots: number; buckets: number } {
    let slots = 0;
    for (const b of this.#buckets.values()) slots += Array.isArray(b) ? b.length : 1;
    return { slots, buckets: this.#buckets.size };
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

/** @internal Test-only: reclaim every parked slot now, synchronously, and forget any pending drain (a test's fake scheduler may never fire). */
export function _drainNow(): number {
  const n = pending.length;
  while (pending.length > 0) reclaim(pending.pop()!);
  scheduled = false;
  return n;
}

/** @internal Test-only: slots stored in a pool (live or awaiting reclaim) and its bucket count. */
export function _poolStats(pool: InternPool<object>): { slots: number; buckets: number } {
  return (pool as InternPoolImpl<object>)._stats();
}

/** @internal Test-only: the stack bound. */
export const _MAX_PENDING = MAX_PENDING;
