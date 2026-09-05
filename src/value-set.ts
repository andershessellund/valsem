// ---------------------------------------------------------------------------
// ValueSet — persistent (immutable) set on a hash-consed CHAMP trie
//
// Same architecture as {@link ValueMap} at stride 1 (member-only slots): the
// backing trie is hash-consed, so equal content yields the same root node,
// deep equality is a pointer comparison on roots, updates share all
// untouched structure, and iteration order is content-determined.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { intern, internHash } from './intern.js';
import { toDraft, type DraftState } from './draft-core.js';
import { createSetDraft, type SetState } from './draft-set.js';
import {
  createTrieConfig,
  trieGet,
  trieInsert,
  trieRemove,
  trieKeys,
  triePairs,
  trieForEach,
  NOT_FOUND,
  _trieStats,
  type HNode,
} from './hamt.js';

const CFG = createTrieConfig(1);

/** Canonical wrapper per root — ephemeron-collected with the root itself. */
const wrappers = new WeakMap<HNode, ValueSet<unknown>>();

/**
 * Persistent (immutable) set with structural identity.
 *
 * Elements are **interned on entry**, so two `ValueSet` instances with
 * structurally equal contents are the same object reference — lineage-free,
 * because the backing trie is hash-consed: sets built independently, in
 * different orders, or via add/delete detours converge on one canonical
 * instance, and deep equality is a pointer comparison. Membership probes
 * are canonicalized, so `has`/`delete` accept any structurally equal value.
 *
 * **Iteration order is unspecified but content-determined.** Element order is
 * not part of the value — `{1, 2}` and `{2, 1}` are the *same* canonical
 * instance — so equal sets iterate identically, in an order driven by
 * (per-process, seeded) element hashes. Never attach meaning to it; if order
 * carries meaning, use a `ValueList`.
 *
 * The backing trie is a private field — never exposed. The ValueSet **is** a
 * `ReadonlySet` itself: pass it anywhere one is accepted, and take a mutable
 * copy with `new Set(valueSet)` when you need one.
 */
export class ValueSet<T> implements ReadonlySet<T> {
  readonly #root: HNode;
  readonly #size: number;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;

  private constructor(root: HNode, size: number) {
    this.#root = root;
    this.#size = size;
    this[hashCodeSym] = root.h;
    Object.freeze(this); // protects the cached [hashCode] too
  }

  static #for<T>(root: HNode, size: number): ValueSet<T> {
    const hit = wrappers.get(root);
    if (hit !== undefined) return hit as ValueSet<T>;
    const fresh = new ValueSet<unknown>(root, size);
    wrappers.set(root, fresh);
    return fresh as ValueSet<T>;
  }

  /** Number of elements. */
  get size(): number {
    return this.#size;
  }

  /** Whether a structurally equal `value` is present (the probe is canonicalized). */
  has(value: T): boolean {
    value = intern(value);
    return trieGet(CFG, this.#root, internHash(value), value) !== NOT_FOUND;
  }

  /** Iterate the elements (content-determined order — see the class docs). */
  values(): SetIterator<T> {
    return trieKeys(CFG, this.#root) as SetIterator<T>;
  }

  /** Iterate the elements (content-determined order — see the class docs). */
  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  /** Alias of {@link values}, as `ReadonlySet.keys` is. */
  keys(): SetIterator<T> {
    return this.values();
  }

  /** Iterate `[value, value]` pairs, as `ReadonlySet.entries` does. */
  entries(): SetIterator<[T, T]> {
    return triePairs(CFG, this.#root) as SetIterator<[T, T]>;
  }

  /** Call `fn` for each element, as `ReadonlySet.forEach` does. */
  forEach(fn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    trieForEach(CFG, this.#root, (slots, i) => fn.call(thisArg, slots[i] as T, slots[i] as T, this));
  }

  // -------------------------------------------------------------------------
  // Set algebra (the rest of the ReadonlySet contract). These return plain,
  // freshly-allocated native Sets — per the standard signatures — so mutating
  // one is harmless; wrap with ValueSet.from(...) to get a canonical value.
  // -------------------------------------------------------------------------

  #native(): Set<T> {
    return new Set<T>(trieKeys(CFG, this.#root) as Iterable<T>);
  }

  /** Elements in this set, `other`, or both — a fresh native `Set`. */
  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    return this.#native().union(other);
  }

  /** Elements in both this set and `other` — a fresh native `Set`. */
  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    return this.#native().intersection(other);
  }

  /** Elements in this set but not `other` — a fresh native `Set`. */
  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    return this.#native().difference(other);
  }

  /** Elements in exactly one of this set and `other` — a fresh native `Set`. */
  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    return this.#native().symmetricDifference(other);
  }

  /** Whether every element of this set is in `other`. */
  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    return this.#native().isSubsetOf(other);
  }

  /** Whether this set contains every element of `other`. */
  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    return this.#native().isSupersetOf(other);
  }

  /** Whether this set shares no element with `other`. */
  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    return this.#native().isDisjointFrom(other);
  }

  [equalsSym](other: unknown): boolean {
    // Hash consing makes deep equality a pointer comparison on roots.
    return other instanceof ValueSet && (other as ValueSet<T>).#root === this.#root;
  }

  /** The `produce` draft protocol: a {@link DraftSet} over this set. */
  [toDraft](parent?: DraftState): SetState<T> {
    return createSetDraft(this, parent, ValueSet.empty);
  }

  /** Add `value` (interned on entry). Returns `this` if a structural equal is present. */
  add(value: T): ValueSet<T> {
    value = intern(value);
    const r = trieInsert(CFG, this.#root, 0, internHash(value), [value]);
    if (r === null) return this;
    return ValueSet.#for<T>(r.node, this.#size + 1);
  }

  /** Remove a structurally equal `value`. Returns `this` if not present. */
  delete(value: T): ValueSet<T> {
    value = intern(value);
    const r = trieRemove(CFG, this.#root, 0, internHash(value), value);
    if (r === null) return this;
    return ValueSet.#for<T>(r.node as HNode, this.#size - 1);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty set. */
  static empty<T>(): ValueSet<T> {
    return ValueSet.#for<T>(CFG.empty, 0);
  }

  /** Canonical ValueSet from an iterable of values (interned on entry). */
  static from<T>(values: Iterable<T>): ValueSet<T> {
    let root: HNode = CFG.empty;
    let size = 0;
    for (const raw of values) {
      const v = intern(raw);
      const r = trieInsert(CFG, root, 0, internHash(v), [v]);
      if (r !== null) {
        root = r.node;
        size++;
      }
    }
    return ValueSet.#for<T>(root, size);
  }

  /** @internal Trie node-pool sizes — exposed for sharing tests. */
  static _nodeStats(): { bnodes: number; cnodes: number } {
    return _trieStats(CFG);
  }
}
