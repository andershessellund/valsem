// ---------------------------------------------------------------------------
// ordered-core — what OrderedMap and OrderedSet share: reading the anchors
// of a full build, applying anchor updates to a trie whose last entry slot
// is the anchor, and the iterator objects the entries come from.
// ---------------------------------------------------------------------------

import { internHash } from './intern.js';
import { same, IteratorBase } from './shared.js';
import { trieGet, trieInsert, NOT_FOUND, type HNode, type TrieConfig } from './hamt.js';

/** The anchor of each member from a full-build update map; every member must have one. */
export function anchorsFor(members: readonly unknown[], updates: Map<unknown, unknown>): unknown[] {
  const anchors = new Array<unknown>(members.length);
  for (let i = 0; i < members.length; i++) {
    if (!updates.has(members[i])) throw new Error('valsem: an ordered collection built without an anchor (this is a bug)');
    anchors[i] = updates.get(members[i]);
  }
  return anchors;
}

/**
 * Apply anchor `updates` (key → anchor) to `root`, whose entries end in an
 * anchor slot. Keys the trie does not hold are skipped — a superseded node
 * may name a key that was just removed — and so are unchanged anchors, at
 * the cost of one lookup, which is what most updates after an edit are.
 */
export function applyAnchorUpdates(cfg: TrieConfig, root: HNode, updates: Map<unknown, unknown>): HNode {
  const stride = cfg.stride;
  for (const [k, a] of updates) {
    const h = internHash(k);
    const cur = trieGet(cfg, root, h, k, 0, stride - 1);
    if (cur === NOT_FOUND || same(cur, a)) continue;
    const entry: unknown[] = [k];
    for (let t = 1; t < stride - 1; t++) entry.push(trieGet(cfg, root, h, k, 0, t));
    entry.push(a);
    root = trieInsert(cfg, root, 0, h, entry)!.node;
  }
  return root;
}

/** `[value, value]` pairs from one iterator — what `ReadonlySet.entries` yields (no iterator helper needed). */
export class PairIterator<T> extends IteratorBase implements IterableIterator<[T, T]> {
  readonly #inner: Iterator<T>;
  constructor(inner: Iterator<T>) {
    super();
    this.#inner = inner;
  }
  next(): IteratorResult<[T, T]> {
    const r = this.#inner.next();
    if (r.done) return { value: undefined, done: true };
    return { value: [r.value, r.value], done: false };
  }
  [Symbol.iterator](): this {
    return this;
  }
}

/** `[key, value]` pairs from two parallel iterators (an explicit iterator object, so the helpers work). */
export class ZipIterator<K, V> extends IteratorBase implements IterableIterator<[K, V]> {
  readonly #keys: Iterator<K>;
  readonly #vals: Iterator<V>;
  constructor(keys: Iterator<K>, vals: Iterator<V>) {
    super();
    this.#keys = keys;
    this.#vals = vals;
  }
  next(): IteratorResult<[K, V]> {
    const k = this.#keys.next();
    if (k.done) return { value: undefined, done: true };
    const v = this.#vals.next();
    return { value: [k.value, v.value as V], done: false };
  }
  [Symbol.iterator](): this {
    return this;
  }
}
