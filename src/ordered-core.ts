// ---------------------------------------------------------------------------
// ordered-core — what OrderedMap and OrderedSet share: the KEYED INDEX (a
// key sequence and the trie that finds each key's position: all of an
// OrderedSet, and the key side of an OrderedMap), the anchor protocol it
// rests on, and the iterator objects the entries come from.
//
// A trie entry is `[key, ...payload, anchor]`: the payload is nothing for
// the set and the value for the map, and the anchor — the last slot of the
// stride — is what `ValueList._indexOf` follows to the key's position. The
// anchor rule is a canonicality rule (equal sequences must index alike), so
// it is applied from here, once.
// ---------------------------------------------------------------------------

import { internHash } from './intern.js';
import { IteratorBase } from './shared.js';
import { trieGet, trieInsert, trieRemove, trieFrom, trieSetLast, NOT_FOUND, type HNode, type TrieConfig } from './hamt.js';
import { ValueList, _ANCHOR_TAIL, _ANCHOR_NONE, type CNode } from './value-list.js';

/** A key sequence and the trie that finds each key's position. */
export interface Keyed {
  readonly list: ValueList<unknown>;
  readonly root: HNode;
}

/** The stored anchor of canonical `k` (the entry's last slot), or the none-anchor if `k` is not a key. */
export function keyedAnchor(cfg: TrieConfig, root: HNode, k: unknown): unknown {
  const a = trieGet(cfg, root, internHash(k), k, 0, cfg.stride - 1);
  return a === NOT_FOUND ? _ANCHOR_NONE : a;
}

/** The position of canonical `k`, or -1 if it is not a key. Owns the consistency check. */
export function keyedIndexOf(cfg: TrieConfig, keyed: Keyed, k: unknown, what: string): number {
  if (trieGet(cfg, keyed.root, internHash(k), k) === NOT_FOUND) return -1;
  const i = ValueList._indexOf(keyed.list, k, (x) => keyedAnchor(cfg, keyed.root, x));
  if (i < 0) throw new Error(`valsem: ${what} anchors are inconsistent (this is a bug)`);
  return i;
}

/** The trie after an edit at `at` made `list` the key list, consing `consed`. */
function reanchor(cfg: TrieConfig, root: HNode, list: ValueList<unknown>, consed: readonly CNode[], prev: ValueList<unknown>, at: number): HNode {
  return consed.length === 0 ? root : applyAnchorUpdates(cfg, root, ValueList._anchorUpdates(consed, list, prev, at));
}

/** `prev` with canonical `k` (hash `h`, not a key yet) and its payload inserted before `at`; `at === length` appends. */
export function keyedInsert(cfg: TrieConfig, prev: Keyed, at: number, k: unknown, h: number, payload: readonly unknown[]): Keyed {
  const { result: list, consed } = ValueList._record(() => (at === prev.list.length ? prev.list.push(k) : prev.list.insert(at, k)));
  const root = trieInsert(cfg, prev.root, 0, h, [k, ...payload, _ANCHOR_TAIL])!.node;
  return { list, root: reanchor(cfg, root, list, consed, prev.list, at) };
}

/** `prev` without canonical `k` (hash `h`, a key), and the position it held. */
export function keyedRemove(cfg: TrieConfig, prev: Keyed, k: unknown, h: number, what: string): { keyed: Keyed; index: number } {
  const index = keyedIndexOf(cfg, prev, k, what);
  const { result: list, consed } = ValueList._record(() => prev.list.remove(index));
  const root = trieRemove(cfg, prev.root, 0, h, k)!.node as HNode;
  return { keyed: { list, root: reanchor(cfg, root, list, consed, prev.list, index) }, index };
}

/**
 * The index of distinct canonical `keys`, with `payload` (one slot's worth per
 * key, or null for none), built in one pass: the key list once, and every
 * anchor read off the nodes that pass consed.
 */
export function keyedBuild(cfg: TrieConfig, keys: unknown[], payload: unknown[] | null): Keyed {
  const { result: list, consed } = ValueList._record(() => ValueList.from(keys));
  const anchors = anchorsFor(keys, ValueList._anchorUpdates(consed, list));
  return { list, root: payload === null ? trieFrom(cfg, keys, anchors) : trieFrom(cfg, keys, payload, anchors) };
}

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
 * may name a key that was just removed — and so are unchanged anchors. One
 * batched descent ({@link trieSetLast}): each touched trie node is rebuilt
 * and consed once, however many of its entries' anchors moved.
 */
export function applyAnchorUpdates(cfg: TrieConfig, root: HNode, updates: Map<unknown, unknown>): HNode {
  const n = updates.size;
  if (n === 0) return root;
  const hs = new Array<number>(n);
  const ks = new Array<unknown>(n);
  const vs = new Array<unknown>(n);
  const ids = new Array<number>(n);
  let j = 0;
  for (const [k, a] of updates) {
    hs[j] = internHash(k);
    ks[j] = k;
    vs[j] = a;
    ids[j] = j;
    j++;
  }
  return trieSetLast(cfg, root, 0, hs, ks, vs, ids);
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
