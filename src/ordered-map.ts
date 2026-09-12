// ---------------------------------------------------------------------------
// OrderedMap — a persistent map that remembers insertion order, with every
// operation O(log n) and canonical instances.
//
// Three canonical parts: a ValueList of the keys (the order), a parallel
// ValueList of the values, and a hash-consed trie from key to (value,
// ANCHOR) — the anchor being the one pointer that lets the key list find a
// key's position in O(log n) (see the anchor section of value-list.ts). The
// value of the map is its entry sequence, so equal key and value lists mean
// the same map; the trie is derived from them, and the wrapper is pooled on
// the two lists.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { intern, internHash } from './intern.js';
import { mix } from './hasher.js';
import { same } from './shared.js';
import { createInternPool } from './intern-pool.js';
import { ValueList, _ANCHOR_TAIL, _ANCHOR_NONE, type CNode } from './value-list.js';
import { createTrieConfig, trieGet, trieInsert, trieRemove, trieFrom, NOT_FOUND, type HNode } from './hamt.js';
import { applyAnchorUpdates, anchorsFor, ZipIterator } from './ordered-core.js';
import { toDraft, type DraftState } from './draft-core.js';
import { createOrderedMapDraft, type OrderedMapState } from './draft-ordered-map.js';

const CFG = createTrieConfig(3); // key, value, anchor
const pool = createInternPool<OrderedMap<unknown, unknown>>();
const SEED = 0x0a4d;

/**
 * Persistent (immutable) insertion-ordered map with canonical instances.
 *
 * The value is the **sequence** of entries: order is part of it, so
 * `OrderedMap.from([['a', 1], ['b', 2]])` differs from the map built the
 * other way round (a `ValueMap` would make them one), and equal sequences
 * are one `===` instance however they were built. Keys and values are
 * interned on entry and probes are canonicalized.
 *
 * `set` on a present key keeps its position, as a native `Map` does; on a
 * new key it appends. `delete` removes; `insertAt` places a new entry at an
 * index. `get`, `has`, `indexOf`, `at`, `set`, `delete` and `insertAt` are
 * O(log n) expected. Iteration is in order, O(n). `keyList` and `valueList`
 * are the canonical `ValueList`s of the keys and values: two maps with the
 * same keys in the same order share one key list, whatever their values
 * did — "did the order change" is a pointer compare.
 *
 * The `OrderedMap` is a `ReadonlyMap`; take a mutable copy with `new Map(m)`.
 */
export class OrderedMap<K, V> implements ReadonlyMap<K, V> {
  readonly #keys: ValueList<K>;
  readonly #vals: ValueList<V>;
  readonly #root: HNode;
  readonly #hash: number;

  private constructor(keys: ValueList<K>, vals: ValueList<V>, root: HNode, hash: number) {
    this.#keys = keys;
    this.#vals = vals;
    this.#root = root;
    this.#hash = hash;
    Object.freeze(this);
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

  /** The canonical map for a (key list, value list) pair; the trie is a function of them. */
  static #of<K, V>(keys: ValueList<K>, vals: ValueList<V>, root: HNode): OrderedMap<K, V> {
    const h = mix(mix(SEED, keys[hashCodeSym]), vals[hashCodeSym]);
    const hit = pool.lookup(h, (c) => c.#keys === keys && c.#vals === vals);
    if (hit !== undefined) return hit as OrderedMap<K, V>;
    return pool.register(new OrderedMap<unknown, unknown>(keys, vals, root, h), h) as OrderedMap<K, V>;
  }

  /** The stored anchor of `k`, or `_ANCHOR_NONE` if `k` is not a key. */
  #anchor(k: unknown): unknown {
    const a = trieGet(CFG, this.#root, internHash(k), k, 0, 2);
    return a === NOT_FOUND ? _ANCHOR_NONE : a;
  }

  /** @internal The stored anchor of a canonical key (`undefined` if absent) — for the consistency tests. */
  _anchorOf(key: K): unknown {
    const a = this.#anchor(intern(key));
    return a === _ANCHOR_NONE ? undefined : a;
  }

  #indexOf(k: unknown): number {
    const i = ValueList._indexOf(this.#keys, k, (x) => this.#anchor(x));
    if (i < 0) throw new Error('valsem: OrderedMap anchors are inconsistent (this is a bug)');
    return i;
  }

  #reanchor(root: HNode, keys: ValueList<K>, consed: readonly CNode[]): HNode {
    return consed.length === 0 ? root : applyAnchorUpdates(CFG, root, ValueList._anchorUpdates(consed, keys));
  }

  /** Number of entries. */
  get size(): number {
    return this.#keys.length;
  }

  /** The keys, in order — the canonical `ValueList` of this key sequence. */
  get keyList(): ValueList<K> {
    return this.#keys;
  }
  /** The values, in key order — the canonical `ValueList` of this value sequence. */
  get valueList(): ValueList<V> {
    return this.#vals;
  }

  /** Whether a structurally equal `key` is present. */
  has(key: K): boolean {
    const k = intern(key);
    return trieGet(CFG, this.#root, internHash(k), k) !== NOT_FOUND;
  }

  /** The value under a structurally equal `key`, or `undefined` if absent. */
  get(key: K): V | undefined {
    const k = intern(key);
    const r = trieGet(CFG, this.#root, internHash(k), k, 0, 1);
    return r === NOT_FOUND ? undefined : (r as V);
  }

  /** The position of a structurally equal `key`, or -1. O(log n). */
  indexOf(key: K): number {
    const k = intern(key);
    if (trieGet(CFG, this.#root, internHash(k), k) === NOT_FOUND) return -1;
    return this.#indexOf(k);
  }

  /** The key at `index`, or `undefined` out of range. */
  keyAt(index: number): K | undefined {
    return this.#keys.get(index);
  }
  /** The value at `index`, or `undefined` out of range. */
  valueAt(index: number): V | undefined {
    return this.#vals.get(index);
  }
  /** The `[key, value]` entry at `index`, or `undefined` out of range. */
  at(index: number): [K, V] | undefined {
    if (index < 0 || index >= this.#keys.length) return undefined;
    return [this.#keys.get(index) as K, this.#vals.get(index) as V];
  }
  /** The first entry, or `undefined` when empty. */
  first(): [K, V] | undefined {
    return this.at(0);
  }
  /** The last entry, or `undefined` when empty. */
  last(): [K, V] | undefined {
    return this.at(this.#keys.length - 1);
  }

  /**
   * Set `key` → `value` (both interned on entry). A present key keeps its
   * position; a new key is appended. Returns `this` if the entry is already
   * present with a structurally equal value.
   */
  set(key: K, value: V): OrderedMap<K, V> {
    const k = intern(key);
    const v = intern(value);
    const h = internHash(k);
    const cur = trieGet(CFG, this.#root, h, k, 0, 1);
    if (cur !== NOT_FOUND) {
      if (same(cur, v)) return this;
      const i = this.#indexOf(k);
      const vals = this.#vals.set(i, v);
      const a = trieGet(CFG, this.#root, h, k, 0, 2);
      const root = trieInsert(CFG, this.#root, 0, h, [k, v, a])!.node;
      return OrderedMap.#of<K, V>(this.#keys, vals, root);
    }
    const { result: keys, consed } = ValueList._record(() => this.#keys.push(k));
    const vals = this.#vals.push(v);
    const root = trieInsert(CFG, this.#root, 0, h, [k, v, _ANCHOR_TAIL])!.node;
    return OrderedMap.#of<K, V>(keys, vals, this.#reanchor(root, keys, consed));
  }

  /** Remove a structurally equal `key`. Returns `this` if absent. */
  delete(key: K): OrderedMap<K, V> {
    const k = intern(key);
    const h = internHash(k);
    if (trieGet(CFG, this.#root, h, k) === NOT_FOUND) return this;
    const i = this.#indexOf(k);
    const { result: keys, consed } = ValueList._record(() => this.#keys.remove(i));
    const vals = this.#vals.remove(i);
    const root = trieRemove(CFG, this.#root, 0, h, k)!.node as HNode;
    return OrderedMap.#of<K, V>(keys, vals, this.#reanchor(root, keys, consed));
  }

  /**
   * Insert a new entry before `index` (0 ≤ index ≤ size). Throws if a
   * structurally equal key is present — a key has one position; delete it
   * first to move it.
   */
  insertAt(index: number, key: K, value: V): OrderedMap<K, V> {
    const n = this.#keys.length;
    if (!Number.isInteger(index) || index < 0 || index > n) {
      throw new RangeError(`OrderedMap.insertAt: index ${index} out of range [0, ${n}]`);
    }
    const k = intern(key);
    const v = intern(value);
    const h = internHash(k);
    if (trieGet(CFG, this.#root, h, k) !== NOT_FOUND) {
      throw new Error('valsem: OrderedMap.insertAt: the key is already present — delete it first to move it');
    }
    if (index === n) return this.set(k, v);
    const { result: keys, consed } = ValueList._record(() => this.#keys.insert(index, k));
    const vals = this.#vals.insert(index, v);
    const root = trieInsert(CFG, this.#root, 0, h, [k, v, _ANCHOR_TAIL])!.node;
    return OrderedMap.#of<K, V>(keys, vals, this.#reanchor(root, keys, consed));
  }

  /** Iterate the keys in order. */
  keys(): MapIterator<K> {
    return this.#keys[Symbol.iterator]() as unknown as MapIterator<K>;
  }
  /** Iterate the values in key order. */
  values(): MapIterator<V> {
    return this.#vals[Symbol.iterator]() as unknown as MapIterator<V>;
  }
  /** Iterate the `[key, value]` entries in order. */
  entries(): MapIterator<[K, V]> {
    return new ZipIterator<K, V>(this.#keys[Symbol.iterator](), this.#vals[Symbol.iterator]()) as unknown as MapIterator<[K, V]>;
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  /** Call `fn` for each entry in order, as `ReadonlyMap.forEach` does. */
  forEach(fn: (value: V, key: K, map: OrderedMap<K, V>) => void, thisArg?: unknown): void {
    const vals = this.#vals;
    this.#keys.forEach((k, i) => fn.call(thisArg, vals.get(i) as V, k, this));
  }

  /** The `produce` draft protocol: a {@link DraftOrderedMap} over this map. */
  [toDraft](parent?: DraftState): OrderedMapState<K, V> {
    return createOrderedMapDraft(this, parent, OrderedMap.empty);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty map. */
  static empty<K, V>(): OrderedMap<K, V> {
    return OrderedMap.#of<K, V>(ValueList.empty<K>(), ValueList.empty<V>(), CFG.empty);
  }

  /**
   * The canonical ordered map of `entries` (interned on entry). A key given
   * twice keeps its first position and its last value, as a native `Map`
   * would. Built in one pass: the two lists once, every anchor read off the
   * nodes that pass consed.
   */
  static from<K, V>(entries: Iterable<readonly [K, V]>): OrderedMap<K, V> {
    const ks: unknown[] = [];
    const vs: unknown[] = [];
    const at = new Map<unknown, number>();
    for (const [rawK, rawV] of entries) {
      const k = intern(rawK);
      const key = k !== k ? NaN : k; // SameValueZero: one NaN key
      const i = at.get(key);
      if (i === undefined) {
        at.set(key, ks.length);
        ks.push(k);
        vs.push(intern(rawV));
      } else {
        vs[i] = intern(rawV);
      }
    }
    return OrderedMap.#build<K, V>(ks, vs);
  }

  /**
   * Canonical ordered map from a plain object, in its own-key order — the
   * JavaScript order, integer-like keys first (string keys only). Record
   * semantics apply: a key mapped to `undefined` is
   * absent and is not carried in. Use {@link set} or {@link from} to store
   * `undefined` deliberately.
   */
  static fromObject<V>(obj: Record<string, V>): OrderedMap<string, V> {
    const ks: unknown[] = [];
    const vs: unknown[] = [];
    for (const k of Object.keys(obj)) {
      const raw = obj[k];
      if (raw === undefined) continue;
      ks.push(k);
      vs.push(intern(raw));
    }
    return OrderedMap.#build<string, V>(ks, vs);
  }

  /** The map for distinct canonical `ks` with canonical `vs`. */
  static #build<K, V>(ks: unknown[], vs: unknown[]): OrderedMap<K, V> {
    if (ks.length === 0) return OrderedMap.empty<K, V>();
    const { result: keys, consed } = ValueList._record(() => ValueList.from(ks as K[]));
    const vals = ValueList.from(vs as V[]);
    const anchors = anchorsFor(ks, ValueList._anchorUpdates(consed, keys));
    return OrderedMap.#of<K, V>(keys, vals, trieFrom(CFG, ks, vs, anchors));
  }
}
