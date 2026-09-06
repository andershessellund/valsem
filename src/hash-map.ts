// ---------------------------------------------------------------------------
// HashMap — a mutable map keyed by content.
//
// Keys are matched by value — hashed and compared structurally in a bucket
// table — and stored as given: never copied, frozen, or pooled. That makes
// it the map for keys that are new values every call (request objects,
// query params, coordinates): a raw key is one hash and one compare, and
// the pool is untouched. Values are stored as-is, so it can index LIVE
// objects — DOM nodes, connections — by structural key.
//
// Two things follow from "stored as given". A canonical key looks up in
// ~50 ns here, but in ~16 ns in `FastMap`, which is a native Map that only
// admits canonical keys — reach for that when your keys are your state. And
// a key mutated after insertion is no longer found: the rule of every hash
// map with mutable keys.
// ---------------------------------------------------------------------------

import { internHash } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { HashTable, type TableEntry } from './hash-table.js';

interface Entry<K, V> extends TableEntry {
  readonly key: K;
  value: V;
}

/**
 * Mutable map with structural key equality: `{ table: 'users', id: 1 }` and
 * `{ id: 1, table: 'users' }` are the same key. Keys are stored as given.
 *
 * @example
 * ```ts
 * const map = new HashMap<{ table: string; id: string }, Row>();
 * map.set({ table: 'users', id: '1' }, row);
 * map.get({ id: '1', table: 'users' }); // → row (key order irrelevant)
 * ```
 */
export class HashMap<K, V> {
  readonly #table = new HashTable<Entry<K, V>>(true);

  /** A map holding `entries`. */
  static from<K, V>(entries: Iterable<readonly [K, V]>): HashMap<K, V> {
    const m = new HashMap<K, V>();
    for (const [k, v] of entries) m.set(k, v);
    return m;
  }

  #find(key: K): Entry<K, V> | undefined {
    return this.#table.find(internHash(key), (e) => e.key === key || deepEqual(e.key, key));
  }

  /** Number of entries in the map. */
  get size(): number {
    return this.#table.size;
  }

  /** Check whether a structurally equal key exists. */
  has(key: K): boolean {
    return this.#find(key) !== undefined;
  }

  /** Get the value for a structurally equal key, or `undefined`. */
  get(key: K): V | undefined {
    return this.#find(key)?.value;
  }

  /** Set a key-value pair. Overwrites if a structurally equal key exists (keeping the stored key). */
  set(key: K, value: V): this {
    const e = this.#find(key);
    if (e !== undefined) e.value = value;
    else this.#table.add({ hash: internHash(key), key, value });
    return this;
  }

  /** Delete an entry by structural key. Returns `true` if found. */
  delete(key: K): boolean {
    const e = this.#find(key);
    return e !== undefined && this.#table.remove(e);
  }

  /**
   * Get existing value or create and insert a new one.
   *
   * Avoids the double-lookup pattern of `if (!has) set(create())`. The
   * `factory` is only called when the key is not found. A factory result of
   * `undefined` is stored and cached like any other value.
   */
  getOrCreate(key: K, factory: (key: K) => V): V {
    const e = this.#find(key);
    if (e !== undefined) return e.value;
    const value = factory(key);
    this.#table.add({ hash: internHash(key), key, value });
    return value;
  }

  /** Remove all entries. */
  clear(): void {
    this.#table.clear();
  }

  /** Iterate over all entries, calling `fn` for each. */
  forEach(fn: (value: V, key: K, map: HashMap<K, V>) => void): void {
    for (const e of this.#table.entries()) fn(e.value, e.key, this);
  }

  /** Yield all `[key, value]` pairs, in insertion order. */
  entries(): IterableIterator<[K, V]> {
    return this.#table.entries().map((e) => [e.key, e.value] as [K, V]);
  }

  /** Yield all keys. */
  keys(): IterableIterator<K> {
    return this.#table.entries().map((e) => e.key);
  }

  /** Yield all values. */
  values(): IterableIterator<V> {
    return this.#table.entries().map((e) => e.value);
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}
