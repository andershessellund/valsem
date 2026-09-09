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
 * `Iterator` (ES2025) as a base class where the runtime has it, a plain base
 * otherwise, so explicit-stack iterator objects inherit the iterator helpers
 * (`map`, `filter`, `take`, …) exactly as generators would.
 */
export const IteratorBase = ((globalThis as { Iterator?: unknown }).Iterator ?? Object) as new () => object;
