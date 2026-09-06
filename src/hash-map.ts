// ---------------------------------------------------------------------------
// HashMap — hash map with structural key equality via interning
//
// Every key is automatically internalized via the global {@link intern}
// pool, so structurally equal keys collapse to the same canonical object.
// Because interning guarantees structural equality ↔ reference equality,
// a plain Map<K, V> keyed by canonical references is sufficient — no
// custom bucketing needed.
// ---------------------------------------------------------------------------

import { intern, isCanonical } from './intern.js';
import { _checking } from './checks.js';

/**
 * Hash map with structural key equality.
 *
 * Keys are interned on insert/lookup, so objects with the same shape and
 * values — regardless of key order — map to the same entry.
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

  /** Number of entries in the map. */
  get size(): number {
    return this.#map.size;
  }

  /** Check whether a structurally equal key exists. */
  has(key: K): boolean {
    return this.#map.has(intern(key));
  }

  /** Get the value for a structurally equal key, or `undefined`. */
  get(key: K): V | undefined {
    return this.#map.get(intern(key));
  }

  /** Set a key-value pair. Overwrites if a structurally equal key exists. */
  set(key: K, value: V): this {
    this.#map.set(intern(key), value);
    return this;
  }

  /** Delete an entry by structural key. Returns `true` if found. */
  delete(key: K): boolean {
    return this.#map.delete(intern(key));
  }

  /**
   * Get existing value or create and insert a new one.
   *
   * Avoids the double-lookup pattern of `if (!has) set(create())`.
   * The `factory` is only called when the key is not found, and receives the
   * canonical (interned) key. A factory result of `undefined` is stored and
   * cached like any other value.
   */
  getOrCreate(key: K, factory: (key: K) => V): V {
    const ik = intern(key);
    // Presence, not `!== undefined`: a stored `undefined` is a cached result
    // too, and must not re-run the factory.
    if (this.#map.has(ik)) return this.#map.get(ik) as V;
    const value = factory(ik);
    this.#map.set(ik, value);
    return value;
  }

  /**
   * Get the value for a key that is already canonical — no intern call, a
   * bare `Map.get`. The promise is yours; while checks are on it is verified
   * (a raw key would silently miss). `skipChecks()` turns the check off.
   */
  getCanonical(key: K): V | undefined {
    if (_checking() && !isCanonical(key)) {
      throw new TypeError(
        'valsem: HashMap.getCanonical() takes a canonical key — a raw key would silently miss. ' +
          'Use get() (which interns), or intern the key first. skipChecks() disables this check.',
      );
    }
    return this.#map.get(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.#map.clear();
  }

  /** Iterate over all entries, calling `fn` for each. */
  forEach(fn: (value: V, key: K, map: HashMap<K, V>) => void): void {
    this.#map.forEach((value, key) => fn(value, key, this));
  }

  /** Yield all `[key, value]` pairs. */
  entries(): IterableIterator<[K, V]> {
    return this.#map.entries();
  }

  /** Yield all keys. */
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

