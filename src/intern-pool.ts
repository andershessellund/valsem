// ---------------------------------------------------------------------------
// intern-pool — weak pools with a global incremental sweeper.
//
// Every pool is a Map<hash, bucket record>; a bucket inlines the singleton
// case (overwhelmingly common under a seeded 32-bit hash) — `refs` is one
// WeakRef until a genuine collision promotes it to an array. The records of
// ALL pools sit in one circular doubly-linked list, and dead refs are
// reclaimed by an incremental sweeper whose cursor advances around that
// circle. The cleanup bill is split three ways:
//
//   * registrations pay the traffic tax — REGISTER_BUDGET slots of sweep
//     credit each, accrued through a pending counter so the fixed cost of a
//     sweep call lands once per TICK_THRESHOLD operations;
//   * GC epochs pay the death tax — ONE FinalizationRegistry sentinel (O(1)
//     cells total, never per entry) fires after each GC — the only event
//     that can create dead refs — and runs one bounded sweep slice;
//   * lookups pay nothing.
//
// A record whose bucket empties unlinks itself and deletes its map entry
// through a per-pool WeakRef to the owning map (one shared WeakRef per pool).
// A dropped pool's records unlink wholesale as the cursor meets them; its
// records whose values still live are visited as live until those values die.
//
// The guarantee: dead pool metadata anywhere is reclaimed within
// O(total metadata / budget) subsequent registrations, or a few GC epochs,
// whichever comes first. If all traffic and GC stop, stranded metadata is
// frozen at its instantaneous footprint — and pooled values themselves are
// never retained at all. Nothing grows without traffic; everything shrinks
// with any traffic. Cleanup is a bounded tax: no monolithic sweep pass, no
// per-entry FinalizationRegistry, no timers.
//
// Requires WeakRef. FinalizationRegistry is optional — used, when present,
// only as the GC-epoch backstop (without it, cleanup is traffic-driven only).
// This design was chosen over per-entry FinalizationRegistry and over
// monolithic threshold sweeps on measurement (scripts/pool-gc-bench.mjs):
// equal-or-better wall time, in-batch and post-GC pauses at baseline GC
// levels, and geometrically-converging dormancy cleanup.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';

const REGISTER_BUDGET = 2; // ref slots of sweep credit per registration
const TICK_THRESHOLD = 16; // run the sweeper once this much credit accrues
const BACKSTOP_MIN_SLICE = 1024; // GC-epoch slice floor …
const BACKSTOP_MAX_SLICE = 32_768; // … and cap: the slice is a pause too

/** A bucket record: one hash's weak members, linked into the global circle. */
interface Node {
  hash: number;
  /** Shared WeakRef to the owning pool's bucket map; null only on the sentinel. */
  owner: WeakRef<Map<number, Node>> | null;
  /** One WeakRef (singleton bucket) or an array (true hash collision); null only on the sentinel. */
  refs: WeakRef<object> | WeakRef<object>[] | null;
  prev: Node;
  next: Node;
}

// The sentinel keeps the circle non-empty; the sweeper skips it free of charge.
const sentinel: Node = {
  hash: 0,
  owner: null,
  refs: null,
  prev: undefined as unknown as Node,
  next: undefined as unknown as Node,
};
sentinel.prev = sentinel;
sentinel.next = sentinel;

let cursor: Node = sentinel;
let slots = 0; // ref slots in the circle (live + not-yet-swept dead)
let pending = 0; // accrued sweep credit not yet spent

/** Insert just behind the cursor: a fresh bucket is visited last. */
function link(record: Node): void {
  const at = cursor;
  const before = at.prev;
  before.next = record;
  record.prev = before;
  record.next = at;
  at.prev = record;
}

/** Detach from the circle; self-loops mark the record unlinked. */
function unlink(record: Node): void {
  record.prev.next = record.next;
  record.next.prev = record.prev;
  record.prev = record;
  record.next = record;
}

function tick(credit: number): void {
  pending += credit;
  if (pending >= TICK_THRESHOLD) {
    const budget = pending;
    pending = 0;
    sweep(budget);
  }
}

function sweep(budget: number): void {
  let node = cursor;
  while (budget > 0) {
    if (node === sentinel) {
      node = node.next;
      if (node === sentinel) break; // circle is empty
      continue;
    }
    const next = node.next;
    const refs = node.refs!;
    // The owner WeakRef is deref'd ONLY on the removal path: live visits (the
    // overwhelmingly common case) touch just the member ref itself.
    if (Array.isArray(refs)) {
      budget -= refs.length;
      let w = 0;
      for (let r = 0; r < refs.length; r++) {
        if (refs[r]!.deref() !== undefined) refs[w++] = refs[r]!;
      }
      slots -= refs.length - w;
      refs.length = w;
      if (w === 0) {
        node.owner!.deref()?.delete(node.hash);
        unlink(node);
      } else if (w === 1) {
        node.refs = refs[0]!; // demote back to the singleton form
      }
    } else {
      budget -= 1;
      if (refs.deref() === undefined) {
        slots -= 1;
        node.owner!.deref()?.delete(node.hash);
        unlink(node);
      }
    }
    node = next;
  }
  cursor = node;
}

// The GC-epoch backstop. The registry must be reachable from a module-level
// binding: an unreferenced FinalizationRegistry is itself collected and its
// callbacks silently stop (measured, not theorized).
let backstop: FinalizationRegistry<number> | undefined;
if (typeof FinalizationRegistry === 'function') {
  const registry = new FinalizationRegistry<number>(() => {
    sweep(Math.min(Math.max(BACKSTOP_MIN_SLICE, slots >> 1), BACKSTOP_MAX_SLICE));
    arm();
  });
  const arm = (): void => registry.register({}, 0);
  backstop = registry;
  arm();
}

/**
 * A typed, weakly-held pool of canonical instances of `T`.
 *
 * Members are retained via `WeakRef` and reclaimed by the shared incremental
 * sweeper (see the module header), so an instance leaves the pool once
 * nothing else references it. This backs the persistent
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
   * pool metadata reclaimed by the sweeper.
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
  readonly #buckets = new Map<number, Node>();
  readonly #owner = new WeakRef(this.#buckets); // ONE shared WeakRef per pool

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const record = this.#buckets.get(hash);
    if (record === undefined) return undefined;
    const refs = record.refs!;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const candidate = ref.deref();
        if (candidate !== undefined && predicate(candidate as T)) return candidate as T;
      }
      return undefined;
    }
    const candidate = refs.deref();
    return candidate !== undefined && predicate(candidate as T) ? (candidate as T) : undefined;
  }

  register(value: T, hash: number): T {
    tick(REGISTER_BUDGET);
    const record = this.#buckets.get(hash);
    if (record === undefined) {
      const fresh: Node = {
        hash,
        owner: this.#owner,
        refs: new WeakRef(value),
        prev: sentinel,
        next: sentinel,
      };
      this.#buckets.set(hash, fresh);
      link(fresh);
      slots += 1;
    } else if (Array.isArray(record.refs)) {
      // Prune dead in passing, then append.
      const refs = record.refs;
      let w = 0;
      for (let r = 0; r < refs.length; r++) {
        if (refs[r]!.deref() !== undefined) refs[w++] = refs[r]!;
      }
      slots -= refs.length - w;
      refs.length = w;
      refs.push(new WeakRef(value));
      slots += 1;
    } else if (record.refs!.deref() === undefined) {
      record.refs = new WeakRef(value); // replace the dead singleton in place
    } else {
      record.refs = [record.refs as WeakRef<object>, new WeakRef(value)];
      slots += 1;
    }
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
    for (const record of this.#buckets.values()) {
      const refs = record.refs!;
      if (Array.isArray(refs)) {
        for (const ref of refs) if (ref.deref() !== undefined) n++;
      } else if (refs.deref() !== undefined) {
        n++;
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

// ---------------------------------------------------------------------------
// Test-only inspection hooks (not exported from the package barrel)
// ---------------------------------------------------------------------------

/** @internal Test-only: run the sweeper for exactly `budget` ref slots. */
export function _sweepNow(budget: number): void {
  sweep(budget);
}

/**
 * @internal Test-only: circle statistics with full linkage validation —
 * throws if the circular list is corrupted.
 */
export function _circleState(): {
  records: number;
  slots: number;
  pending: number;
  backstopArmed: boolean;
} {
  let records = 0;
  let prev: Node = sentinel;
  let node = sentinel.next;
  while (node !== sentinel) {
    if (node.prev !== prev) throw new Error('intern-pool circle corrupted: prev linkage');
    records++;
    if (records > 100_000_000) throw new Error('intern-pool circle corrupted: unterminated');
    prev = node;
    node = node.next;
  }
  if (sentinel.prev !== prev) throw new Error('intern-pool circle corrupted: tail linkage');
  return { records, slots, pending, backstopArmed: backstop !== undefined };
}
