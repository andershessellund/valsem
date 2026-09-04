// ---------------------------------------------------------------------------
// intern-pool — generic weak-pool helper used by persistent collections
//
// Backed by `Map<number, Set<WeakRef<T>>>` (hash → bucket of weak refs).
// Dead refs are reclaimed by a periodic sweep instead of FinalizationRegistry
// so that cleanup is synchronous and predictable even inside tight loops.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';

const INITIAL_SWEEP_THRESHOLD = 64;

/**
 * A typed, weakly-held pool of canonical instances of `T`.
 *
 * Members are retained via `WeakRef` and reclaimed by a periodic sweep, so an
 * instance leaves the pool once nothing else references it. This backs the
 * persistent {@link InternArray}/{@link InternMap}/{@link InternSet}/
 * {@link InternString} collections and any consumer value type (see
 * {@link createInternPool}).
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
   * weakly retained; once unreferenced elsewhere it will be GC'd and
   * removed from the pool on the next sweep.
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

  /** @internal Pool size — exposed for tests. */
  size(): number;
}

class InternPoolImpl<T extends object> implements InternPool<T> {
  readonly #buckets = new Map<number, Set<WeakRef<T>>>();
  #liveCount = 0;
  #mutsSinceSweep = 0;
  #sweepThreshold = INITIAL_SWEEP_THRESHOLD;

  // -------------------------------------------------------------------------
  // GC sweep
  // -------------------------------------------------------------------------

  #sweep(): void {
    for (const [hash, bucket] of this.#buckets) {
      for (const ref of bucket) {
        if (ref.deref() === undefined) {
          bucket.delete(ref);
          this.#liveCount--;
        }
      }
      if (bucket.size === 0) this.#buckets.delete(hash);
    }
    this.#mutsSinceSweep = 0;
    this.#sweepThreshold = Math.max(INITIAL_SWEEP_THRESHOLD, this.#liveCount);
  }

  // -------------------------------------------------------------------------
  // InternPool<T>
  // -------------------------------------------------------------------------

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const bucket = this.#buckets.get(hash);
    if (bucket === undefined) return undefined;
    for (const ref of bucket) {
      const candidate = ref.deref();
      if (candidate === undefined) continue;
      if (predicate(candidate)) return candidate;
    }
    return undefined;
  }

  register(value: T, hash: number): T {
    if (++this.#mutsSinceSweep >= this.#sweepThreshold) this.#sweep();

    let bucket = this.#buckets.get(hash);
    if (bucket === undefined) {
      bucket = new Set();
      this.#buckets.set(hash, bucket);
    }
    bucket.add(new WeakRef(value));
    this.#liveCount++;
    return value;
  }

  intern(object: T): T {
    if ((object as Record<symbol, unknown>)[internedSym] === true) return object;
    const hash = (object as Record<symbol, unknown>)[hashCodeSym] as number;
    const found = this.lookup(hash, c => {
      const eq = (object as Record<symbol, unknown>)[equalsSym];
      return typeof eq === 'function' && !!(eq as (other: unknown) => boolean).call(object, c);
    });
    if (found !== undefined) return found;
    (object as Record<symbol, unknown>)[internedSym] = true;
    Object.freeze(object);
    return this.register(object, hash);
  }

  size(): number {
    let n = 0;
    for (const bucket of this.#buckets.values()) {
      for (const ref of bucket) {
        if (ref.deref() !== undefined) n++;
      }
    }
    return n;
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

