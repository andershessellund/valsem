// ---------------------------------------------------------------------------
// HashSet — a mutable set of values, keyed by content. HashMap's twin.
//
// By default every element is interned on the way in, so structurally equal
// elements are one member and a native `Set` of canonical references does
// the rest: a canonical element is tested at native-Set speed. With
// `{ intern: false }` elements are matched by content without being
// canonicalised — hashed and compared in a bucket table — for elements that
// are fresh values every call; they are stored as given, so do not mutate
// them afterwards.
// ---------------------------------------------------------------------------

import { intern, internHash, isCanonical } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { _checking } from './checks.js';
import { HashTable, type TableEntry } from './hash-table.js';
import type { HashMapOptions } from './hash-map.js';

/** Options for {@link HashSet} — the same as {@link HashMap}'s. */
export type HashSetOptions = HashMapOptions;

interface Entry<T> extends TableEntry {
  readonly value: T;
}

/**
 * Mutable set with structural membership.
 *
 * Elements are interned on add/lookup, so objects with the same shape and
 * values — regardless of key order — are one member.
 *
 * @example
 * ```ts
 * const seen = new HashSet<{ x: number; y: number }>();
 * seen.add({ x: 1, y: 2 });
 * seen.has({ y: 2, x: 1 }); // true (key order irrelevant)
 * ```
 */
export class HashSet<T> {
  /** Interning mode: canonical elements. */
  readonly #set: Set<T> | null;
  /** Non-interning mode: content-matched entries. */
  readonly #table: HashTable<Entry<T>> | null;

  constructor(options: HashSetOptions = {}) {
    if (options.intern ?? true) {
      this.#set = new Set();
      this.#table = null;
    } else {
      this.#set = null;
      this.#table = new HashTable(true);
    }
  }

  /** A set holding `values`. */
  static from<T>(values: Iterable<T>, options?: HashSetOptions): HashSet<T> {
    const s = new HashSet<T>(options);
    for (const v of values) s.add(v);
    return s;
  }

  #find(value: T): Entry<T> | undefined {
    return this.#table!.find(internHash(value), (e) => e.value === value || deepEqual(e.value, value));
  }

  /** Number of members. */
  get size(): number {
    return this.#set !== null ? this.#set.size : this.#table!.size;
  }

  /** Whether a structurally equal element is a member. */
  has(value: T): boolean {
    return this.#set !== null ? this.#set.has(intern(value)) : this.#find(value) !== undefined;
  }

  /** Add an element. A structurally equal member already present is kept as stored. */
  add(value: T): this {
    if (this.#set !== null) {
      this.#set.add(intern(value));
      return this;
    }
    if (this.#find(value) === undefined) this.#table!.add({ hash: internHash(value), value });
    return this;
  }

  /** Remove the member structurally equal to `value`. Returns `true` if found. */
  delete(value: T): boolean {
    if (this.#set !== null) return this.#set.delete(intern(value));
    const e = this.#find(value);
    return e !== undefined && this.#table!.remove(e);
  }

  /**
   * Whether a canonical element is a member — no intern call, a bare
   * `Set.has`. The promise is yours; while checks are on it is verified (a
   * raw element would silently miss). `skipChecks()` turns the check off.
   */
  hasCanonical(value: T): boolean {
    if (_checking() && !isCanonical(value)) {
      throw new TypeError(
        'valsem: HashSet.hasCanonical() takes a canonical element — a raw one would silently miss. ' +
          'Use has() (which interns), or intern the element first. skipChecks() disables this check.',
      );
    }
    return this.#set !== null ? this.#set.has(value) : this.#find(value) !== undefined;
  }

  /** Remove all members. */
  clear(): void {
    if (this.#set !== null) this.#set.clear();
    else this.#table!.clear();
  }

  /** Iterate over all members, calling `fn` for each. */
  forEach(fn: (value: T, value2: T, set: HashSet<T>) => void): void {
    for (const v of this.values()) fn(v, v, this);
  }

  /** Yield all members, in insertion order. */
  values(): IterableIterator<T> {
    if (this.#set !== null) return this.#set.values();
    return this.#table!.entries().map((e) => e.value);
  }

  /** Alias of {@link values}, as on `Set`. */
  keys(): IterableIterator<T> {
    return this.values();
  }

  /** Yield `[value, value]` pairs, as on `Set`. */
  entries(): IterableIterator<[T, T]> {
    if (this.#set !== null) return this.#set.entries();
    return this.#table!.entries().map((e) => [e.value, e.value] as [T, T]);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }
}
