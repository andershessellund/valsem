// ---------------------------------------------------------------------------
// InternSet — persistent (immutable) set with incremental hashing
//
// Same scheme as {@link InternMap} but per-element instead of per-entry.
//
//     elementHash(v) = scramble(hashValue)
//     rollingSum     = Σ elementHash(vᵢ)        (commutative)
//     h              = mix(TAG_INTERN_SET, size) ⊕ rollingSum
// ---------------------------------------------------------------------------

import { deepHash } from './deep-hash.js';
import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';

function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

function scramble(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

const pool = createInternPool<InternSet<unknown>>();

/**
 * Persistent (immutable) set with structural identity.
 *
 * Two `InternSet` instances containing the same `===` elements are the same
 * object reference.
 *
 * **Iteration order is unspecified.** Element order is not part of the value —
 * `{1, 2}` and `{2, 1}` are the *same* canonical instance — so the order you
 * observe is whichever structurally-equal set was pooled first, and can differ
 * between runs. Never depend on it; if order carries meaning, use an
 * `InternArray` (a future `OrderedSet` may cover this).
 *
 * The backing `Set` is a private field — never exposed, because JavaScript has
 * no way to make a `Set` immutable at runtime (`Object.freeze` does not reach
 * its internal slots), and handing it out would let one accidental `add()`
 * corrupt the shared canonical instance and its cached hash. Instead the
 * InternSet **is** a `ReadonlySet` itself: pass it anywhere one is accepted,
 * and take a mutable copy with `new Set(internSet)` when you need one.
 */
export class InternSet<T> implements ReadonlySet<T> {
  readonly #set: Set<T>;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;
  readonly #rollingSum: number;

  private constructor(set: Set<T>, hash: number, rollingSum: number) {
    this.#set = set;
    this[hashCodeSym] = hash;
    this.#rollingSum = rollingSum;
    Object.freeze(this); // see InternMap — protects the cached [hashCode] too
  }

  /** Number of elements. */
  get size(): number {
    return this.#set.size;
  }

  /** Whether the canonical `value` is present (matched by reference). */
  has(value: T): boolean {
    return this.#set.has(value);
  }

  /** Iterate the elements (unspecified order — see the class docs). */
  values(): SetIterator<T> {
    return this.#set.values();
  }

  /** Iterate the elements (unspecified order — see the class docs). */
  [Symbol.iterator](): SetIterator<T> {
    return this.#set.values();
  }

  /** Alias of {@link values}, as `ReadonlySet.keys` is. */
  keys(): SetIterator<T> {
    return this.#set.keys();
  }

  /** Iterate `[value, value]` pairs, as `ReadonlySet.entries` does. */
  entries(): SetIterator<[T, T]> {
    return this.#set.entries();
  }

  /** Call `fn` for each element, as `ReadonlySet.forEach` does. */
  forEach(fn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#set.forEach((v) => fn.call(thisArg, v, v, this));
  }

  // -------------------------------------------------------------------------
  // Set algebra (the rest of the ReadonlySet contract). These return plain,
  // freshly-allocated native Sets — per the standard signatures — so mutating
  // one is harmless; wrap with InternSet.from(...) to get a canonical value.
  // -------------------------------------------------------------------------

  /** Elements in this set, `other`, or both — a fresh native `Set`. */
  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    return this.#set.union(other);
  }

  /** Elements in both this set and `other` — a fresh native `Set`. */
  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    return this.#set.intersection(other);
  }

  /** Elements in this set but not `other` — a fresh native `Set`. */
  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    return this.#set.difference(other);
  }

  /** Elements in exactly one of this set and `other` — a fresh native `Set`. */
  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    return this.#set.symmetricDifference(other);
  }

  /** Whether every element of this set is in `other`. */
  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    return this.#set.isSubsetOf(other);
  }

  /** Whether this set contains every element of `other`. */
  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    return this.#set.isSupersetOf(other);
  }

  /** Whether this set shares no element with `other`. */
  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    return this.#set.isDisjointFrom(other);
  }

  [equalsSym](other: unknown): boolean {
    if (!(other instanceof InternSet)) return false;
    if (this.#set.size !== other.#set.size) return false;
    for (const v of this.#set) if (!other.#set.has(v)) return false;
    return true;
  }

  /** Add `value`. Returns `this` if already present. */
  add(value: T): InternSet<T> {
    if (this.#set.has(value)) return this;
    const vh = scramble(deepHash(value));
    const newSum = (this.#rollingSum + vh) >>> 0;
    const newSize = this.#set.size + 1;
    const newHash = (mix(0, newSize) ^ newSum) >>> 0;

    const self = this;
    const found = pool.lookup(newHash, c => {
      if (c.#set.size !== newSize) return false;
      if (!c.#set.has(value)) return false;
      for (const v of self.#set) if (!c.#set.has(v)) return false;
      return true;
    });
    if (found !== undefined) return found as InternSet<T>;

    const fresh = new Set<T>(this.#set);
    fresh.add(value);
    return pool.register(new InternSet<T>(fresh, newHash, newSum), newHash) as InternSet<T>;
  }

  /** Remove `value`. Returns `this` if not present. */
  delete(value: T): InternSet<T> {
    if (!this.#set.has(value)) return this;
    const vh = scramble(deepHash(value));
    const newSum = (this.#rollingSum - vh) >>> 0;
    const newSize = this.#set.size - 1;
    const newHash = (mix(0, newSize) ^ newSum) >>> 0;
    if (newSize === 0) return InternSet.empty<T>();

    const self = this;
    const found = pool.lookup(newHash, c => {
      if (c.#set.size !== newSize) return false;
      if (c.#set.has(value)) return false;
      for (const v of self.#set) if (v !== value && !c.#set.has(v)) return false;
      return true;
    });
    if (found !== undefined) return found as InternSet<T>;

    const fresh = new Set<T>();
    for (const v of this.#set) if (v !== value) fresh.add(v);
    return pool.register(new InternSet<T>(fresh, newHash, newSum), newHash) as InternSet<T>;
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty set. */
  static empty<T>(): InternSet<T> {
    return EMPTY as InternSet<T>;
  }

  /** Canonical InternSet from an iterable of values. */
  static from<T>(values: Iterable<T>): InternSet<T> {
    const s = new Set<T>(values);
    return InternSet._fromSet(s);
  }

  /** @internal Build from an existing Set (consumes the set — the caller must not keep a reference). */
  static _fromSet<T>(s: Set<T>): InternSet<T> {
    if (s.size === 0) return EMPTY as InternSet<T>;
    let sum = 0;
    for (const v of s) sum = (sum + scramble(deepHash(v))) >>> 0;
    const hash = (mix(0, s.size) ^ sum) >>> 0;
    const found = pool.lookup(hash, c => {
      if (c.#set.size !== s.size) return false;
      for (const v of s) if (!c.#set.has(v)) return false;
      return true;
    });
    if (found !== undefined) return found as InternSet<T>;
    return pool.register(new InternSet<T>(s, hash, sum), hash) as InternSet<T>;
  }

  /** @internal Pool size — exposed for tests. */
  static _poolSize(): number {
    return pool.size();
  }
}

const EMPTY: InternSet<unknown> = (() => {
  const s = new Set<unknown>();
  const hash = (mix(0, 0) ^ 0) >>> 0;
  const inst = new (InternSet as any)(s, hash, 0) as InternSet<unknown>;
  return pool.register(inst, hash);
})();
