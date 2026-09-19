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
 * Positional arguments are CHECKED, never coerced (D45). Three kinds, by what
 * the argument names:
 *
 * - an ELEMENT ({@link elementIndex}: `get`, `at`, `set`, `remove`): an
 *   integer in `[0, length)`. There is no element anywhere else, so there is
 *   nothing to answer with and nothing to edit;
 * - an INSERTION POINT ({@link insertionIndex}: `insert`, `insertAt`,
 *   `splice`'s start): an integer in `[0, length]`. An edit lands in canonical
 *   state, so the place it names must exist: no counting from the end, where
 *   an `indexOf` miss (-1) would name the last element;
 * - a RANGE. `slice`'s bounds ({@link indexArg}) are any integer or
 *   ±Infinity, clamped as `Array` clamps them; `splice`'s count
 *   ({@link extentArg}) is an amount, an integer ≥ 0 or Infinity, clamped to
 *   what is there, and a negative one throws where `Array` reads it as 0. A
 *   range has an answer wherever it points, the part of it that exists, and
 *   correct programs overshoot on purpose: the top ten of seven, the short
 *   last page, "the rest".
 *
 * What none of them does is `Array`'s ToIntegerOrInfinity, where `NaN`
 * becomes index 0 and `1.7` becomes 1: a non-integer is an upstream
 * computation that went wrong, and it throws a `RangeError` everywhere.
 */
export function indexArg(value: number, operation: string, name: string): number {
  if (Number.isInteger(value)) return value === 0 ? 0 : value; // -0 is 0
  if (value === Infinity || value === -Infinity) return value;
  throw notAnInteger(value, operation, name);
}

/** How many elements: an integer ≥ 0 or Infinity ("the rest"); the caller clamps it to what is there. */
export function extentArg(value: number, operation: string, name: string): number {
  const n = indexArg(value, operation, name);
  if (n < 0) throw new RangeError(`${operation}: ${name} must not be negative, got ${n}`);
  return n;
}

/** The index of an element that exists: an integer in `[0, length)`. */
export function elementIndex(index: number, length: number, operation: string): number {
  if (!Number.isInteger(index)) throw notAnInteger(index, operation, 'index');
  if (index < 0 || index >= length) throw outOfRange(index, length, operation, 'index', ')');
  return index === 0 ? 0 : index;
}

/** A place an element can go: an integer in `[0, length]`. */
export function insertionIndex(index: number, length: number, operation: string, name = 'index'): number {
  if (!Number.isInteger(index)) throw notAnInteger(index, operation, name);
  if (index < 0 || index > length) throw outOfRange(index, length, operation, name, ']');
  return index === 0 ? 0 : index;
}

function notAnInteger(value: unknown, operation: string, name: string): RangeError {
  return new RangeError(`${operation}: ${name} must be an integer, got ${showArg(value)}`);
}

function outOfRange(index: number, length: number, operation: string, name: string, close: ')' | ']'): RangeError {
  return new RangeError(`${operation}: ${name} ${index} out of range [0, ${length}${close}`);
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

/**
 * Node's `util.inspect` hook (what `console.log` and a debugger's hover
 * call). A class with `#private` state prints as `ValueList {}`: the
 * contents are exactly what inspection cannot see. A registered symbol, so
 * nothing is imported and other runtimes ignore it.
 */
export const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** The three arguments Node passes the hook, as far as they are used. */
export type InspectOptions = { depth?: number | null };
export type Inspect = (value: unknown, options?: object) => string;

/**
 * `Name(size) <contents>`, the way Node prints a native collection:
 * `ValueList(2) [ 1, 2 ]`, `ValueMap(1) { 'a' => 1 }`. `body` is an array, or
 * a native Map/Set of the contents, which Node already knows how to print
 * (nesting, depth, colours, line breaks); its own `Map(1) ` label is dropped
 * for ours.
 */
export function inspectAs(name: string, size: number, body: () => unknown, depth: number, options: InspectOptions, inspect: Inspect): string {
  // Node passes the levels LEFT as `depth` (`options.depth` is the total, and
  // `null`, "no limit", makes the first a meaningless negative number). The
  // body stands for this collection, so it is printed with exactly the levels
  // this collection has left: one more level would be lost to the wrapper.
  const unlimited = options.depth === null;
  if (!unlimited && depth < 0) return `[${name}]`;
  const inner = inspect(body(), { ...options, depth: unlimited ? null : depth });
  return `${name}(${size}) ${inner.replace(/^(?:Map|Set)\(\d+\) /, '')}`;
}

/**
 * The property through which a draft object exposes its state. Defined in
 * this leaf module, not in draft-core, so that the lowest layer can tell a
 * draft from "a class that is not a value" in its error path without
 * importing the draft machinery. A per-copy symbol, like every internal one.
 */
export const DRAFT_STATE: unique symbol = Symbol('valsem.draftState') as any;
