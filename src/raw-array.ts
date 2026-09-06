// ---------------------------------------------------------------------------
// RawArray — a raw response you take canonical slices from.
//
// Admitting a large response costs ~1.8 µs per 10-field record, paid for
// every record whether or not anything ever looks at it. A RawArray holds
// the raw array as received and admits an element the first time it is
// sliced or read: `slice(a, b)` returns the canonical array of that range,
// with each element interned once and memoized per slot, so the visible
// window of a 100k-row response costs 100 interns, and a refetch's unchanged
// rows come back `===` to the previous view's, because they land on the
// same pool instances.
//
// It is not a value of its content — two views over equal JSON are two
// values — but it IS canonical by identity, like a class instance that
// opted in: `[hashCode]` is an identity hash, `[equals]` is `===`, and it is
// marked `[interned]`, so it can sit inside canonical state as an opaque
// leaf that `intern` and `produce` pass through. `slice()` with no
// arguments is the explicit "admit everything" step.
//
// This belongs with `InternedString` in the category "things you are
// unlikely to need, but if you do, here it is".
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { intern } from './intern.js';
import { hashNumber } from './hasher.js';

let nextId = 0;
const NOT_YET = Symbol('valsem.raw-array.not-yet');

/**
 * A raw array — as parsed from JSON — that admits its elements on demand.
 * `slice(start, end)` is the canonical array of that range; `get(i)` one
 * canonical element. Elements are interned once and memoized per slot, so
 * the same row is the same object across slices and, when its content is
 * unchanged, across views over successive fetches.
 *
 * Not a value of its content: each view is its own value (identity), so it
 * can be held inside canonical state as an opaque leaf.
 */
export class RawArray<T> {
  /** The raw elements, released slot by slot as they are admitted. */
  readonly #raw: (unknown | undefined)[];
  /** Per-slot canonical element, or NOT_YET. */
  readonly #canon: unknown[];
  readonly #hash: number;

  private constructor(raw: unknown[]) {
    this.#raw = raw;
    this.#canon = new Array<unknown>(raw.length).fill(NOT_YET);
    this.#hash = hashNumber(++nextId) >>> 0;
    Object.freeze(this);
  }

  /** A view over `items` — copied once (a native slice, holes preserved), so later mutation of the caller's array does not reach it. */
  static from<T>(items: Iterable<T> | ArrayLike<T>): RawArray<T> {
    const arr = Array.isArray(items) ? (items as unknown[]).slice() : Array.from(items as Iterable<T>);
    return new RawArray<T>(arr);
  }

  get length(): number {
    return this.#canon.length;
  }

  #admit(i: number): T {
    const c = this.#canon[i];
    if (c !== NOT_YET) return c as T;
    // Own slot only: a hole would read through to Array.prototype.
    const raw = Object.prototype.hasOwnProperty.call(this.#raw, i) ? this.#raw[i] : undefined;
    const v = intern(raw) as T;
    this.#canon[i] = v;
    this.#raw[i] = undefined; // the raw record is not needed again
    return v;
  }

  /** The canonical element at `index`, admitted on first read; `undefined` out of range. */
  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.#canon.length) return undefined;
    return this.#admit(index);
  }

  /**
   * The canonical array of elements `[start, end)` — `Array.prototype.slice`
   * bounds (negative indices count from the end; both optional). Each
   * element is admitted once; the array itself is interned, so equal slices
   * are the same object.
   */
  slice(start = 0, end = this.#canon.length): readonly T[] {
    const n = this.#canon.length;
    if (start < 0) start = Math.max(0, n + start);
    if (end < 0) end = Math.max(0, n + end);
    start = Math.min(start, n);
    end = Math.min(end, n);
    const out: unknown[] = [];
    for (let i = start; i < end; i++) out.push(this.#admit(i));
    return intern(out) as readonly T[];
  }

  /** The whole content, admitted — what `JSON.stringify` sees. */
  toJSON(): readonly T[] {
    return this.slice();
  }

  get [hashCodeSym](): number {
    return this.#hash;
  }
  get [internedSym](): true {
    return true;
  }
  [equalsSym](other: unknown): boolean {
    return other === this;
  }
}
