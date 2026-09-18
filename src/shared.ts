// ---------------------------------------------------------------------------
// shared — the few primitives every canonical structure needs, in one leaf
// module (no imports), so the collections, the trie and the interner do not
// each carry a copy.
// ---------------------------------------------------------------------------

/**
 * SameValueZero — identity plus NaN-equals-NaN. On canonical children this IS
 * structural equality (equal content is one instance), except for NaN, which
 * `!==` itself and would otherwise split every pool and trie it entered.
 * Matches native Map/Set key semantics.
 */
export function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

/** Pairwise {@link same} over two slot arrays — the consing predicate for a node's children. */
export function sameSlots(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Array elements as VALUES: own slots only
//
// An array's value is its length and its own elements, with a hole meaning
// `undefined`. JavaScript's index read is not that: `arr[i]` on a hole walks
// the prototype chain, so with `Array.prototype[1] = x` (or the same on
// Object.prototype) a sparse array reads `x` at its hole. The native copies
// do the same — `slice`, spread, `Array.from`, `concat` and the array iterator
// all use [[Get]] or HasProperty, and turn an inherited index into an OWN
// element of the copy. valsem handles `__proto__` as data and promises that
// prototype pollution cannot reach a value; every walk over an array that may
// be raw therefore reads through these two, and never through the chain.
// Canonical arrays are dense by construction and need neither.
// ---------------------------------------------------------------------------

/** An empty array: `i in CHAIN` asks whether this realm's Array prototype chain has an index `i`. */
const CHAIN: readonly unknown[] = [];
const ARRAY_PROTOTYPE: unknown = Array.prototype;

/**
 * Whether the element read at `i` is certainly the array's OWN, without asking.
 * A plain read can only be wrong where the prototype chain HAS that index, and
 * `i in CHAIN` asks exactly that. On V8 it is free (`in` on an array is an
 * inline-cached element check), and unlike a probing read it runs no getter.
 * It speaks for arrays whose chain is CHAIN's; a subclass instance or an array
 * from another realm has a different one, and gets the exact check.
 */
function chainIsClean(arr: readonly unknown[], i: number): boolean {
  return Object.getPrototypeOf(arr) === ARRAY_PROTOTYPE && !(i in CHAIN);
}

/**
 * The element at `i` as a value: the own slot, or `undefined` for a hole.
 *
 * `Object.hasOwn` per element is the obvious spelling, and costs more than the
 * read it guards on every raw-array walk there is: about 1.4x a bare loop on
 * V8, 12x on JavaScriptCore. So: read. `undefined` is right either way, since
 * a hole and an own `undefined` are one value. Anything else is the own
 * element unless the chain has `i`, and only then is the exact check needed.
 */
export function ownAt(arr: readonly unknown[], i: number): unknown {
  const v = arr[i];
  if (v === undefined || chainIsClean(arr, i)) return v;
  return Object.hasOwn(arr, i) ? v : undefined;
}

/** A dense copy of `arr`'s own elements, holes as `undefined` — what `slice()` would be if it could not see the prototype chain. */
export function ownElements<T>(arr: readonly T[]): T[] {
  const out = new Array<T>(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = ownAt(arr, i) as T;
  return out;
}

/**
 * What to iterate when the collections' `from` is handed `values`: an array by
 * its own elements, anything else by its iterator. The array iterator reads
 * each index with [[Get]], so `for…of` over a sparse array yields whatever the
 * prototype chain holds at its holes.
 */
export function ownIterable<T>(values: Iterable<T>): Iterable<T> {
  return Array.isArray(values) ? ownElements(values as T[]) : values;
}

/** A `[key, value]` entry, read by own slots when it is an array (destructuring would iterate it). */
export function ownPair<K, V>(entry: readonly [K, V]): readonly [K, V] {
  return Array.isArray(entry) ? [ownAt(entry, 0) as K, ownAt(entry, 1) as V] : entry;
}

/** Whether `arr` has a hole: an index below its length that is not an own property. */
export function hasHoles(arr: readonly unknown[]): boolean {
  for (let i = 0; i < arr.length; i++) {
    // A defined read over a clean chain is an own element. `undefined` may be
    // a hole, and so may a defined read where the chain has `i`: ask.
    if (arr[i] !== undefined && chainIsClean(arr, i)) continue;
    if (!Object.hasOwn(arr, i)) return true;
  }
  return false;
}

/**
 * `ToIntegerOrInfinity` — the coercion `Array.prototype.slice`/`splice` give
 * their index arguments: fractions truncate, `NaN` (and so `undefined`) is 0,
 * `-0` is 0, infinities stay. The collections' `slice`/`splice` promise Array
 * bounds, and without this a fractional index walked the tree to a position
 * between elements and built a list of `undefined`s — which was then interned.
 */
export function toInteger(n: number): number {
  const t = Math.trunc(n);
  return t !== t || t === 0 ? 0 : t;
}

/**
 * `Iterator` (ES2025) as a base class where the runtime has it, a plain base
 * otherwise, so explicit-stack iterator objects inherit the iterator helpers
 * (`map`, `filter`, `take`, …) exactly as generators would.
 */
export const IteratorBase = ((globalThis as { Iterator?: unknown }).Iterator ?? Object) as new () => object;
