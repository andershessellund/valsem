// ---------------------------------------------------------------------------
// ValueMap — persistent (immutable) map on a hash-consed CHAMP trie
//
// The backing structure (hamt.ts) is hash-consed: equal content yields the
// SAME root node object, process-wide. Consequences:
//
//   * deep equality of two ValueMaps is `#root === #root` — O(1), lineage-free
//     (two maps built independently, in any order, converge);
//   * the wrapper itself canonicalizes through a WeakMap keyed by root
//     (ephemeron semantics — no scan, no sweep needed);
//   * updates path-copy O(log n) nodes and share the rest with every other
//     map holding equal subtrees — memory sits at the distinct-subtree floor;
//   * iteration order is structure-determined, hence content-determined: two
//     equal maps iterate identically (still arbitrary-looking — never
//     semantic).
//
// The map hash is the consed root hash: O(1) to read, computed once per novel
// node, never recomputed for shared structure.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { internHash } from './intern.js';
import {
  createTrieConfig,
  trieGet,
  trieInsert,
  trieRemove,
  trieEntries,
  trieKeys,
  NOT_FOUND,
  _trieStats,
  type HNode,
} from './hamt.js';

const CFG = createTrieConfig(2);

/** Canonical wrapper per root — ephemeron-collected with the root itself. */
const wrappers = new WeakMap<HNode, ValueMap<unknown, unknown>>();

/**
 * Persistent (immutable) map with structural identity.
 *
 * Two `ValueMap` instances with the same set of `(===, ===)` entries are the
 * same object reference — and because the backing trie is hash-consed, that
 * holds *lineage-free*: maps built independently, in different orders, or via
 * insert/delete detours all converge on one canonical instance, and deep
 * equality between any two ValueMaps is a pointer comparison.
 *
 * **Iteration order is unspecified but content-determined.** Entry order is
 * not part of the value — `{a→1, b→2}` and `{b→2, a→1}` are the *same*
 * canonical instance — so equal maps iterate identically, in an order driven
 * by (per-process, seeded) key hashes. Never attach meaning to it; if order
 * carries meaning, use a `ValueList` of `[key, value]` pairs.
 *
 * The backing trie is a private field — never exposed. The ValueMap **is** a
 * `ReadonlyMap` itself: pass it anywhere one is accepted, and take a mutable
 * copy with `new Map(valueMap)` when you need one.
 */
export class ValueMap<K, V> implements ReadonlyMap<K, V> {
  readonly #root: HNode;
  readonly #size: number;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;

  private constructor(root: HNode, size: number) {
    this.#root = root;
    this.#size = size;
    this[hashCodeSym] = root.h;
    // The instance is frozen: reassigning a public field like the cached
    // [hashCode] would silently corrupt canonical identity.
    Object.freeze(this);
  }

  static #for<K, V>(root: HNode, size: number): ValueMap<K, V> {
    const hit = wrappers.get(root);
    if (hit !== undefined) return hit as ValueMap<K, V>;
    const fresh = new ValueMap<unknown, unknown>(root, size);
    wrappers.set(root, fresh);
    return fresh as ValueMap<K, V>;
  }

  /** Number of entries. */
  get size(): number {
    return this.#size;
  }

  /** Whether the canonical `key` is present (matched by SameValueZero). */
  has(key: K): boolean {
    return trieGet(CFG, this.#root, internHash(key), key) !== NOT_FOUND;
  }

  /** The value for the canonical `key`, or `undefined` if absent. */
  get(key: K): V | undefined {
    const r = trieGet(CFG, this.#root, internHash(key), key);
    return r === NOT_FOUND ? undefined : (r as V);
  }

  /** Iterate the keys (content-determined order — see the class docs). */
  keys(): MapIterator<K> {
    return trieKeys(CFG, this.#root) as MapIterator<K>;
  }

  /** Iterate the values (content-determined order — see the class docs). */
  values(): MapIterator<V> {
    const root = this.#root;
    return (function* () {
      for (const [, v] of trieEntries(CFG, root)) yield v as V;
    })() as MapIterator<V>;
  }

  /** Iterate the `[key, value]` entries (content-determined order — see the class docs). */
  entries(): MapIterator<[K, V]> {
    return trieEntries(CFG, this.#root) as MapIterator<[K, V]>;
  }

  /** Iterate the `[key, value]` entries (content-determined order — see the class docs). */
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  /** Call `fn` for each entry, as `ReadonlyMap.forEach` does. */
  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of trieEntries(CFG, this.#root)) {
      fn.call(thisArg, v as V, k as K, this);
    }
  }

  [equalsSym](other: unknown): boolean {
    // Hash consing makes deep equality a pointer comparison on roots.
    return other instanceof ValueMap && (other as ValueMap<K, V>).#root === this.#root;
  }

  /**
   * Set `key` → `value`. Returns the canonical ValueMap with the entry
   * applied. If the entry is already present and SameValueZero-equal,
   * returns `this`.
   */
  set(key: K, value: V): ValueMap<K, V> {
    const r = trieInsert(CFG, this.#root, 0, internHash(key), [key, value]);
    if (r === null) return this;
    return ValueMap.#for<K, V>(r.node, this.#size + (r.added ? 1 : 0));
  }

  /** Remove `key`. Returns `this` if `key` was not present. */
  delete(key: K): ValueMap<K, V> {
    const r = trieRemove(CFG, this.#root, 0, internHash(key), key);
    if (r === null) return this;
    return ValueMap.#for<K, V>(r.node as HNode, this.#size - 1);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty map. */
  static empty<K, V>(): ValueMap<K, V> {
    return ValueMap.#for<K, V>(CFG.empty, 0);
  }

  /** Canonical ValueMap from an iterable of `[key, value]` entries. */
  static from<K, V>(entries: Iterable<readonly [K, V]>): ValueMap<K, V> {
    let root: HNode = CFG.empty;
    let size = 0;
    for (const [k, v] of entries) {
      const r = trieInsert(CFG, root, 0, internHash(k), [k, v]);
      if (r !== null) {
        root = r.node;
        if (r.added) size++;
      }
    }
    return ValueMap.#for<K, V>(root, size);
  }

  /**
   * Canonical ValueMap from a plain object (string keys only).
   *
   * The input is a *record*, so record semantics apply to it: a key mapped to
   * `undefined` is an absent key and is not carried into the map. To store
   * `undefined` deliberately, use {@link set} or {@link from} — inside a
   * ValueMap it is a legitimate value, distinct from absence.
   */
  static fromObject<V>(obj: Record<string, V>): ValueMap<string, V> {
    let root: HNode = CFG.empty;
    let size = 0;
    for (const k in obj) {
      const v = obj[k];
      if (v === undefined) continue;
      const r = trieInsert(CFG, root, 0, internHash(k), [k, v]);
      if (r !== null) {
        root = r.node;
        if (r.added) size++;
      }
    }
    return ValueMap.#for<string, V>(root, size);
  }

  /** @internal Trie node-pool sizes — exposed for sharing tests. */
  static _nodeStats(): { bnodes: number; cnodes: number } {
    return _trieStats(CFG);
  }
}
