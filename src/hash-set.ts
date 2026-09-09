// ---------------------------------------------------------------------------
// HashSet — a mutable set of values. HashMap's twin: a native Set of
// canonical members, every member interned on the way in, on `add` and on
// every lookup alike. Members are stored canonical, so a member mutated
// after insertion changes nothing and iteration yields canonical values.
// ---------------------------------------------------------------------------

import { intern } from './intern.js';

/**
 * Mutable set with value membership: `{ x: 1, y: 2 }` and `{ y: 2, x: 1 }`
 * are one member. Members are interned on entry.
 *
 * @example
 * ```ts
 * const seen = new HashSet<{ x: number; y: number }>();
 * seen.add({ x: 1, y: 2 });
 * seen.has({ y: 2, x: 1 }); // true (key order irrelevant)
 * ```
 */
export class HashSet<T> {
  readonly #set = new Set<T>();

  /** A set holding `values`. */
  static from<T>(values: Iterable<T>): HashSet<T> {
    const s = new HashSet<T>();
    for (const v of values) s.add(v);
    return s;
  }

  /** Number of members. */
  get size(): number {
    return this.#set.size;
  }

  /** Whether an equal element is a member. */
  has(value: T): boolean {
    return this.#set.has(intern(value));
  }

  /** Add an element. */
  add(value: T): this {
    this.#set.add(intern(value));
    return this;
  }

  /** Remove the member equal to `value`. Returns `true` if found. */
  delete(value: T): boolean {
    return this.#set.delete(intern(value));
  }

  /** Remove all members. */
  clear(): void {
    this.#set.clear();
  }

  /** Iterate over all members, calling `fn` for each. */
  forEach(fn: (value: T, value2: T, set: HashSet<T>) => void): void {
    for (const v of this.#set) fn(v, v, this);
  }

  /** Yield all members, in insertion order — canonical values. */
  values(): IterableIterator<T> {
    return this.#set.values();
  }

  /** Alias of {@link values}, as on `Set`. */
  keys(): IterableIterator<T> {
    return this.#set.values();
  }

  /** Yield `[value, value]` pairs, as on `Set`. */
  entries(): IterableIterator<[T, T]> {
    return this.#set.entries();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#set.values();
  }
}
