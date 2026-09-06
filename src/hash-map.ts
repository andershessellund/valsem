// ---------------------------------------------------------------------------
// HashMap — a mutable map keyed by content.
//
// Two modes, one class. By default every key is interned on the way in, so
// structurally equal keys collapse to one canonical object and a plain
// `Map<K, V>` keyed by reference does the rest: a canonical key looks up at
// native-Map speed, and the map holds canonical keys. With `{ intern: false }`
// keys are matched by content WITHOUT being canonicalised — hashed and
// compared in a bucket table — for the case where keys are fresh values
// every call (request objects, query params): no copy, no freeze, no pool
// entry per novel key, and a raw-key hit ~1.7× faster. On canonical keys the
// default mode is faster. Keys are then stored as given; mutating one
// afterwards corrupts the map, as in any hash map with mutable keys.
// ---------------------------------------------------------------------------

import { intern, internHash, isCanonical } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { _checking } from './checks.js';
import { HashTable, type TableEntry } from './hash-table.js';

export interface HashMapOptions {
  /**
   * Intern keys on the way in (default `true`): lookups on canonical keys
   * run at native-`Map` speed and the map holds canonical keys. `false`
   * matches keys by content without canonicalising them — for keys that are
   * new values every call; they are stored as given, so do not mutate them.
   */
  intern?: boolean;
}

interface Entry<K, V> extends TableEntry {
  readonly key: K;
  value: V;
}

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
  /** Interning mode: canonical key → value. */
  readonly #map: Map<K, V> | null;
  /** Non-interning mode: content-matched entries. */
  readonly #table: HashTable<Entry<K, V>> | null;

  constructor(options: HashMapOptions = {}) {
    if (options.intern ?? true) {
      this.#map = new Map();
      this.#table = null;
    } else {
      this.#map = null;
      this.#table = new HashTable(true);
    }
  }

  #find(key: K): Entry<K, V> | undefined {
    return this.#table!.find(internHash(key), (e) => e.key === key || deepEqual(e.key, key));
  }

  /** Number of entries in the map. */
  get size(): number {
    return this.#map !== null ? this.#map.size : this.#table!.size;
  }

  /** Check whether a structurally equal key exists. */
  has(key: K): boolean {
    return this.#map !== null ? this.#map.has(intern(key)) : this.#find(key) !== undefined;
  }

  /** Get the value for a structurally equal key, or `undefined`. */
  get(key: K): V | undefined {
    return this.#map !== null ? this.#map.get(intern(key)) : this.#find(key)?.value;
  }

  /** Set a key-value pair. Overwrites if a structurally equal key exists (keeping the stored key). */
  set(key: K, value: V): this {
    if (this.#map !== null) {
      this.#map.set(intern(key), value);
      return this;
    }
    const e = this.#find(key);
    if (e !== undefined) e.value = value;
    else this.#table!.add({ hash: internHash(key), key, value });
    return this;
  }

  /** Delete an entry by structural key. Returns `true` if found. */
  delete(key: K): boolean {
    if (this.#map !== null) return this.#map.delete(intern(key));
    const e = this.#find(key);
    return e !== undefined && this.#table!.remove(e);
  }

  /**
   * Get existing value or create and insert a new one.
   *
   * Avoids the double-lookup pattern of `if (!has) set(create())`.
   * The `factory` is only called when the key is not found, and receives the
   * key as the map will hold it (canonical in the default mode). A factory
   * result of `undefined` is stored and cached like any other value.
   */
  getOrCreate(key: K, factory: (key: K) => V): V {
    if (this.#map !== null) {
      const ik = intern(key);
      // Presence, not `!== undefined`: a stored `undefined` is a cached result
      // too, and must not re-run the factory.
      if (this.#map.has(ik)) return this.#map.get(ik) as V;
      const value = factory(ik);
      this.#map.set(ik, value);
      return value;
    }
    const e = this.#find(key);
    if (e !== undefined) return e.value;
    const value = factory(key);
    this.#table!.add({ hash: internHash(key), key, value });
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
    return this.#map !== null ? this.#map.get(key) : this.#find(key)?.value;
  }

  /** Remove all entries. */
  clear(): void {
    if (this.#map !== null) this.#map.clear();
    else this.#table!.clear();
  }

  /** Iterate over all entries, calling `fn` for each. */
  forEach(fn: (value: V, key: K, map: HashMap<K, V>) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this);
  }

  /** Yield all `[key, value]` pairs, in insertion order. */
  entries(): IterableIterator<[K, V]> {
    if (this.#map !== null) return this.#map.entries();
    return this.#table!.entries().map((e) => [e.key, e.value] as [K, V]);
  }

  /** Yield all keys. */
  keys(): IterableIterator<K> {
    if (this.#map !== null) return this.#map.keys();
    return this.#table!.entries().map((e) => e.key);
  }

  /** Yield all values. */
  values(): IterableIterator<V> {
    if (this.#map !== null) return this.#map.values();
    return this.#table!.entries().map((e) => e.value);
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}
