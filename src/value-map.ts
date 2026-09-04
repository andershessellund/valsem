// ---------------------------------------------------------------------------
// ValueMap — persistent (immutable) map with incremental hashing
//
// Mutator methods (`set`, `delete`) compute the new hash from the
// existing hash in O(1), look up the canonical instance in the pool,
// and **skip allocation entirely on a hit**. This is the workhorse
// for value-types like `BudgetVector` where the same few configurations
// recur millions of times.
//
// Hash scheme: order-independent entry sum
//
//     entryHash(k, v) = scramble(hashKey + hashValue · q)        (odd q)
//     rollingSum      = Σ entryHash(kᵢ, vᵢ)        (commutative)
//     h               = mix(TAG_INTERN_MAP, size) ⊕ rollingSum
//
// Updates:
//     set(k, v) [new]:    sum' = sum + entryHash(k, v);          size' = size+1
//     set(k, v) [exists]: sum' = sum − entryHash(k,oldV) + entryHash(k, v)
//     delete(k):          sum' = sum − entryHash(k, oldV);       size' = size−1
// ---------------------------------------------------------------------------

import { deepHash } from './deep-hash.js';
import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';

const Q = 0xc2b2ae3d | 0;          // odd; second-prime spread for value mixing

/** Ordered hash combine — boost-style. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

/** Avalanche scramble for unordered accumulation. */
function scramble(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function entryHash(kh: number, vh: number): number {
  return scramble((kh + Math.imul(vh, Q)) >>> 0);
}

const pool = createInternPool<ValueMap<unknown, unknown>>();

/**
 * Persistent (immutable) map with structural identity.
 *
 * Two `ValueMap` instances with the same set of `(===, ===)` entries are the
 * same object reference.
 *
 * **Iteration order is unspecified.** Entry order is not part of the value —
 * `{a→1, b→2}` and `{b→2, a→1}` are the *same* canonical instance — so the
 * order you observe is whichever structurally-equal map was pooled first, and
 * can differ between runs. Never depend on it; if order carries meaning, use an
 * `ValueList` of `[key, value]` pairs (a future `OrderedMap` may cover this).
 *
 * The backing `Map` is a private field — never exposed, because JavaScript has
 * no way to make a `Map` immutable at runtime (`Object.freeze` does not reach
 * its internal slots), and handing it out would let one accidental `set()`
 * corrupt the shared canonical instance and its cached hash. Instead the
 * ValueMap **is** a `ReadonlyMap` itself: pass it anywhere one is accepted,
 * and take a mutable copy with `new Map(internMap)` when you need one.
 */
export class ValueMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;
  /** Σ entryHash(kᵢ, vᵢ) — used for incremental updates. */
  readonly #rollingSum: number;

  private constructor(map: Map<K, V>, hash: number, rollingSum: number) {
    this.#map = map;
    this[hashCodeSym] = hash;
    this.#rollingSum = rollingSum;
    // The instance itself is frozen (the backing Map is a private field, so
    // this covers everything reachable): reassigning a public field like the
    // cached [hashCode] would silently corrupt pool identity.
    Object.freeze(this);
  }

  /** Number of entries. */
  get size(): number {
    return this.#map.size;
  }

  /** Whether the canonical `key` is present (matched by reference). */
  has(key: K): boolean {
    return this.#map.has(key);
  }

  /** The value for the canonical `key`, or `undefined` if absent. */
  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  /** Iterate the keys (unspecified order — see the class docs). */
  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  /** Iterate the values (unspecified order — see the class docs). */
  values(): MapIterator<V> {
    return this.#map.values();
  }

  /** Iterate the `[key, value]` entries (unspecified order — see the class docs). */
  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  /** Iterate the `[key, value]` entries (unspecified order — see the class docs). */
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  /** Call `fn` for each entry, as `ReadonlyMap.forEach` does. */
  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((v, k) => fn.call(thisArg, v, k, this));
  }

  [equalsSym](other: unknown): boolean {
    if (!(other instanceof ValueMap)) return false;
    if (this.#map.size !== other.#map.size) return false;
    for (const [k, v] of this.#map) {
      if (!other.#map.has(k) || other.#map.get(k) !== v) return false;
    }
    return true;
  }

  /**
   * Set `key` → `value`. Returns the canonical ValueMap with the entry
   * applied. If the entry is already present and equal, returns `this`.
   */
  set(key: K, value: V): ValueMap<K, V> {
    const had = this.#map.has(key);
    const oldV = had ? this.#map.get(key)! : undefined;
    if (had && oldV === value) return this;

    const kh = deepHash(key);
    const vhNew = deepHash(value);
    let newSum: number;
    let newSize: number;
    if (had) {
      const vhOld = deepHash(oldV as V);
      newSum = (this.#rollingSum - entryHash(kh, vhOld) + entryHash(kh, vhNew)) >>> 0;
      newSize = this.#map.size;
    } else {
      newSum = (this.#rollingSum + entryHash(kh, vhNew)) >>> 0;
      newSize = this.#map.size + 1;
    }
    const newHash = (mix(0, newSize) ^ newSum) >>> 0;

    const self = this;
    const found = pool.lookup(newHash, c => {
      if (c.#map.size !== newSize) return false;
      // Candidate must contain (key, value) and otherwise match self.
      if (!c.#map.has(key) || c.#map.get(key) !== value) return false;
      for (const [k, v] of self.#map) {
        if (k === key) continue;
        // has() as well as get(): `undefined` is a legitimate stored value in
        // an ValueMap (unlike in a record), so get() alone cannot tell a
        // stored undefined from an absent key on a hash-collided candidate.
        if (!c.#map.has(k) || c.#map.get(k) !== v) return false;
      }
      return true;
    });
    if (found !== undefined) return found as ValueMap<K, V>;

    const fresh = new Map<K, V>(this.#map);
    fresh.set(key, value);
    Object.freeze(fresh);
    return pool.register(new ValueMap<K, V>(fresh, newHash, newSum), newHash) as ValueMap<K, V>;
  }

  /** Remove `key`. Returns `this` if `key` was not present. */
  delete(key: K): ValueMap<K, V> {
    if (!this.#map.has(key)) return this;
    const oldV = this.#map.get(key)!;
    const kh = deepHash(key);
    const vhOld = deepHash(oldV);
    const newSum = (this.#rollingSum - entryHash(kh, vhOld)) >>> 0;
    const newSize = this.#map.size - 1;
    const newHash = (mix(0, newSize) ^ newSum) >>> 0;
    if (newSize === 0) return ValueMap.empty<K, V>();

    const self = this;
    const found = pool.lookup(newHash, c => {
      if (c.#map.size !== newSize) return false;
      if (c.#map.has(key)) return false;
      for (const [k, v] of self.#map) {
        if (k === key) continue;
        if (!c.#map.has(k) || c.#map.get(k) !== v) return false; // see set()
      }
      return true;
    });
    if (found !== undefined) return found as ValueMap<K, V>;

    const fresh = new Map<K, V>();
    for (const [k, v] of this.#map) if (k !== key) fresh.set(k, v);
    return pool.register(new ValueMap<K, V>(fresh, newHash, newSum), newHash) as ValueMap<K, V>;
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty map. */
  static empty<K, V>(): ValueMap<K, V> {
    return EMPTY as ValueMap<K, V>;
  }

  /** Canonical ValueMap from an iterable of `[key, value]` entries. */
  static from<K, V>(entries: Iterable<readonly [K, V]>): ValueMap<K, V> {
    const m = new Map<K, V>();
    for (const [k, v] of entries) m.set(k, v);
    return ValueMap._fromMap(m);
  }

  /**
   * Canonical ValueMap from a plain object (string keys only).
   *
   * The input is a *record*, so record semantics apply to it: a key mapped to
   * `undefined` is an absent key and is not carried into the map. To store
   * `undefined` deliberately, use {@link set} or {@link from} — inside an
   * ValueMap it is a legitimate value, distinct from absence.
   */
  static fromObject<V>(obj: Record<string, V>): ValueMap<string, V> {
    const m = new Map<string, V>();
    for (const k in obj) {
      const v = obj[k];
      if (v === undefined) continue;
      m.set(k, v);
    }
    return ValueMap._fromMap(m);
  }

  /** @internal Build from an existing Map (consumes the map — the caller must not keep a reference). */
  static _fromMap<K, V>(m: Map<K, V>): ValueMap<K, V> {
    if (m.size === 0) return EMPTY as ValueMap<K, V>;
    let sum = 0;
    for (const [k, v] of m) {
      sum = (sum + entryHash(deepHash(k), deepHash(v))) >>> 0;
    }
    const hash = (mix(0, m.size) ^ sum) >>> 0;
    const found = pool.lookup(hash, c => {
      if (c.#map.size !== m.size) return false;
      for (const [k, v] of m) {
        if (!c.#map.has(k) || c.#map.get(k) !== v) return false;
      }
      return true;
    });
    if (found !== undefined) return found as ValueMap<K, V>;
    return pool.register(new ValueMap<K, V>(m, hash, sum), hash) as ValueMap<K, V>;
  }

  /** @internal Pool size — exposed for tests. */
  static _poolSize(): number {
    return pool.size();
  }
}

const EMPTY: ValueMap<unknown, unknown> = (() => {
  const m = new Map<unknown, unknown>();
  const hash = (mix(0, 0) ^ 0) >>> 0;
  const inst = new (ValueMap as any)(m, hash, 0) as ValueMap<unknown, unknown>;
  return pool.register(inst, hash);
})();
