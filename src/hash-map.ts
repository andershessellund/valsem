// ---------------------------------------------------------------------------
// HashMap — a mutable map keyed by value.
//
// A native Map keyed by the canonical key: every key is interned on the way
// in, on `set` and on every lookup alike, so `{ table: 'users', id: 1 }` and
// `{ id: 1, table: 'users' }` address one entry. A canonical key costs one
// cache probe over the native lookup (~20 ns); a raw key is interned first,
// a pool lookup (~300 ns for a small record). Keys are stored canonical —
// frozen, pooled, independent of the caller's object — so a key mutated
// after insertion changes nothing, and iteration yields values you can hand
// straight to a native Map or `fastEquals`. Values are stored as-is, so it
// can index LIVE objects — DOM nodes, connections — by value.
//
// For the last few nanoseconds: intern your keys and use a native Map.
// ---------------------------------------------------------------------------

import { intern } from './intern.js';

/**
 * Mutable map with value-keyed entries: `{ table: 'users', id: 1 }` and
 * `{ id: 1, table: 'users' }` are the same key. Keys are interned on entry.
 *
 * @example
 * ```ts
 * const map = new HashMap<{ table: string; id: string }, Row>();
 * map.set({ table: 'users', id: '1' }, row);
 * map.get({ id: '1', table: 'users' }); // → row (key order irrelevant)
 * ```
 */
export class HashMap<K, V> {
  readonly #map = new Map<K, V>();

  /** A map holding `entries`. */
  static from<K, V>(entries: Iterable<readonly [K, V]>): HashMap<K, V> {
    const m = new HashMap<K, V>();
    for (const [k, v] of entries) m.set(k, v);
    return m;
  }

  /** Number of entries in the map. */
  get size(): number {
    return this.#map.size;
  }

  /** Check whether an equal key exists. */
  has(key: K): boolean {
    return this.#map.has(intern(key));
  }

  /** Get the value for an equal key, or `undefined`. */
  get(key: K): V | undefined {
    return this.#map.get(intern(key));
  }

  /** Set a key-value pair. Overwrites if an equal key exists. */
  set(key: K, value: V): this {
    this.#map.set(intern(key), value);
    return this;
  }

  /** Delete an entry by key. Returns `true` if found. */
  delete(key: K): boolean {
    return this.#map.delete(intern(key));
  }

  /**
   * Get existing value or create and insert a new one.
   *
   * Avoids the double-lookup pattern of `if (!has) set(create())`. The
   * `factory` is only called when the key is not found, and receives the
   * canonical key. A factory result of `undefined` is stored and cached like
   * any other value.
   */
  getOrCreate(key: K, factory: (key: K) => V): V {
    const k = intern(key);
    const m = this.#map;
    const existing = m.get(k);
    if (existing !== undefined || m.has(k)) return existing as V;
    const value = factory(k);
    m.set(k, value);
    return value;
  }

  /** Remove all entries. */
  clear(): void {
    this.#map.clear();
  }

  /** Iterate over all entries, calling `fn` for each. */
  forEach(fn: (value: V, key: K, map: HashMap<K, V>) => void): void {
    for (const [k, v] of this.#map) fn(v, k, this);
  }

  /** Yield all `[key, value]` pairs, in insertion order. Keys are canonical. */
  entries(): IterableIterator<[K, V]> {
    return this.#map.entries();
  }

  /** Yield all keys — canonical values. */
  keys(): IterableIterator<K> {
    return this.#map.keys();
  }

  /** Yield all values. */
  values(): IterableIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.#map.entries();
  }
}
