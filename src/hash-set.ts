// ---------------------------------------------------------------------------
// HashSet — a mutable set of values, matched by content. HashMap's twin:
// members are hashed and compared structurally and stored as given, never
// copied, frozen, or pooled. For members that are your (canonical) state,
// `FastSet` is a native Set that only admits canonical elements.
// ---------------------------------------------------------------------------

import { internHash } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { HashTable, type TableEntry } from './hash-table.js';

interface Entry<T> extends TableEntry {
  readonly value: T;
}

/**
 * Mutable set with structural membership: `{ x: 1, y: 2 }` and
 * `{ y: 2, x: 1 }` are one member. Members are stored as given.
 *
 * @example
 * ```ts
 * const seen = new HashSet<{ x: number; y: number }>();
 * seen.add({ x: 1, y: 2 });
 * seen.has({ y: 2, x: 1 }); // true (key order irrelevant)
 * ```
 */
export class HashSet<T> {
  readonly #table = new HashTable<Entry<T>>(true);

  /** A set holding `values`. */
  static from<T>(values: Iterable<T>): HashSet<T> {
    const s = new HashSet<T>();
    for (const v of values) s.add(v);
    return s;
  }

  #find(value: T): Entry<T> | undefined {
    return this.#table.find(internHash(value), (e) => e.value === value || deepEqual(e.value, value));
  }

  /** Number of members. */
  get size(): number {
    return this.#table.size;
  }

  /** Whether a structurally equal element is a member. */
  has(value: T): boolean {
    return this.#find(value) !== undefined;
  }

  /** Add an element. A structurally equal member already present is kept as stored. */
  add(value: T): this {
    if (this.#find(value) === undefined) this.#table.add({ hash: internHash(value), value });
    return this;
  }

  /** Remove the member structurally equal to `value`. Returns `true` if found. */
  delete(value: T): boolean {
    const e = this.#find(value);
    return e !== undefined && this.#table.remove(e);
  }

  /** Remove all members. */
  clear(): void {
    this.#table.clear();
  }

  /** Iterate over all members, calling `fn` for each. */
  forEach(fn: (value: T, value2: T, set: HashSet<T>) => void): void {
    for (const e of this.#table.entries()) fn(e.value, e.value, this);
  }

  /** Yield all members, in insertion order. */
  values(): IterableIterator<T> {
    return this.#table.entries().map((e) => e.value);
  }

  /** Alias of {@link values}, as on `Set`. */
  keys(): IterableIterator<T> {
    return this.values();
  }

  /** Yield `[value, value]` pairs, as on `Set`. */
  entries(): IterableIterator<[T, T]> {
    return this.#table.entries().map((e) => [e.value, e.value] as [T, T]);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }
}
