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

/**
 * An index ARGUMENT, checked and never coerced: an integer, or ±Infinity
 * (which clamps like any out-of-range integer: `slice(0, Infinity)`), with
 * `-0` read as `0`. Anything else throws a `RangeError` naming the operation
 * and the argument.
 *
 * `Array.prototype.slice`/`splice` run their arguments through
 * `ToIntegerOrInfinity`: `NaN`, `undefined` and `'x'` become 0, `1.7` becomes
 * 1, `'2'` becomes 2. Two halves of that are worth telling apart. CLAMPING an
 * integer is the feature: `slice(-3)`, `slice(0, 1000)` on a short list and
 * `splice(-2, 1)` say what they mean, and the callers of this function keep
 * all of it. COERCING a non-integer is not: a `NaN` index is an upstream
 * computation that went wrong, and turning it into "index 0" edits a place
 * nobody chose, silently, in a value that is then canonical. The write paths
 * (`set`, `insertAt`, `d.arr[NaN] = x`) always threw; this makes it the one
 * rule for every operation that takes a position (D45).
 */
export function indexArg(value: number, operation: string, name: string): number {
  if (Number.isInteger(value)) return value === 0 ? 0 : value; // -0 is 0
  if (value === Infinity || value === -Infinity) return value;
  throw new RangeError(`${operation}: ${name} must be an integer, got ${showArg(value)}`);
}

/** A caller's argument, for an error message: strings quoted, and nothing that can throw or run long. */
function showArg(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'an array' : 'an object';
  return String(value); // numbers, booleans, null, undefined, symbols
}

/**
 * `Iterator` (ES2025) as a base class where the runtime has it, a plain base
 * otherwise, so explicit-stack iterator objects inherit the iterator helpers
 * (`map`, `filter`, `take`, …) exactly as generators would.
 */
export const IteratorBase = ((globalThis as { Iterator?: unknown }).Iterator ?? Object) as new () => object;
