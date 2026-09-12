// ---------------------------------------------------------------------------
// OrderedSet — a persistent set that remembers insertion order, with every
// operation O(log n) and canonical instances.
//
// Two canonical parts: a ValueList of the members (the order — and the
// value: the set IS its member sequence) and a hash-consed trie from member
// to ANCHOR, the one pointer that lets the list find a member's position in
// O(log n) (see the anchor section of value-list.ts). Equal member sequences
// are the same list, hence the same OrderedSet; the trie is derived, and
// the wrapper is pooled on the list alone.
//
// Immutable.js keeps order with a map from key to list index and leaves
// holes in the list on delete, compacting occasionally — a representation
// that depends on delete history, which hash consing cannot allow. Anchors
// are a function of the content, so the shape stays canonical.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { intern, internHash } from './intern.js';
import { mix } from './hasher.js';
import { createInternPool } from './intern-pool.js';
import { ValueList, _ANCHOR_TAIL, _ANCHOR_NONE, type CNode } from './value-list.js';
import { createTrieConfig, trieGet, trieInsert, trieRemove, trieFrom, NOT_FOUND, type HNode } from './hamt.js';
import { applyAnchorUpdates, anchorsFor, PairIterator } from './ordered-core.js';
import { toDraft, type DraftState } from './draft-core.js';
import { createOrderedSetDraft, type OrderedSetState } from './draft-ordered-set.js';

const CFG = createTrieConfig(2); // member, anchor
const pool = createInternPool<OrderedSet<unknown>>();
const SEED = 0x05e7;

/** The `ReadonlySet` read contract; the set algebra is `ValueSet`'s business (`ValueSet.from(orderedSet)`). */
type ReadonlySetReads<T> = Pick<ReadonlySet<T>, 'size' | 'has' | 'keys' | 'values' | 'entries' | typeof Symbol.iterator>;

/**
 * Persistent (immutable) insertion-ordered set with canonical instances.
 *
 * The value is the **sequence** of distinct members: `OrderedSet.from([1, 2])`
 * and `OrderedSet.from([2, 1])` are different values (a `ValueSet` would make
 * them one), and equal sequences are one `===` instance however they were
 * built. Members are interned on entry and probes are canonicalized, as in
 * every valsem collection.
 *
 * `add` appends (a present member stays where it is); `delete` removes;
 * `insertAt` places a new member at an index. `has`, `indexOf`, `at`,
 * `add`, `delete` and `insertAt` are all O(log n) expected. Iteration is in
 * order, O(n), and `valueList` is the canonical `ValueList` of the members,
 * shared with every other structure holding that sequence.
 */
export class OrderedSet<T> implements ReadonlySetLike<T>, ReadonlySetReads<T> {
  readonly #list: ValueList<T>;
  readonly #root: HNode;
  readonly #hash: number;

  private constructor(list: ValueList<T>, root: HNode, hash: number) {
    this.#list = list;
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

  /** The canonical set for a member list (the trie is a function of the list). */
  static #of<T>(list: ValueList<T>, root: HNode): OrderedSet<T> {
    const h = mix(SEED, list[hashCodeSym]);
    const hit = pool.lookup(h, (c) => c.#list === list);
    if (hit !== undefined) return hit as OrderedSet<T>;
    return pool.register(new OrderedSet<unknown>(list, root, h), h) as OrderedSet<T>;
  }

  /** The stored anchor of `k`, or `_ANCHOR_NONE` if `k` is not a member. */
  #anchor(k: unknown): unknown {
    const a = trieGet(CFG, this.#root, internHash(k), k);
    return a === NOT_FOUND ? _ANCHOR_NONE : a;
  }

  /** @internal The stored anchor of a canonical member (`undefined` if absent) — for the consistency tests. */
  _anchorOf(value: T): unknown {
    const a = this.#anchor(intern(value));
    return a === _ANCHOR_NONE ? undefined : a;
  }

  /** The trie after `list` became the member list through an operation that consed `consed`. */
  #reanchor(root: HNode, list: ValueList<T>, consed: readonly CNode[]): HNode {
    return consed.length === 0 ? root : applyAnchorUpdates(CFG, root, ValueList._anchorUpdates(consed, list));
  }

  /** Number of members. */
  get size(): number {
    return this.#list.length;
  }

  /** The members, in order — the canonical `ValueList` of this sequence. */
  get valueList(): ValueList<T> {
    return this.#list;
  }

  /** Whether a structurally equal `value` is a member. */
  has(value: T): boolean {
    const v = intern(value);
    return trieGet(CFG, this.#root, internHash(v), v) !== NOT_FOUND;
  }

  /** The position of a structurally equal `value`, or -1. O(log n). */
  indexOf(value: T): number {
    return ValueList._indexOf(this.#list, intern(value), (k) => this.#anchor(k));
  }

  /** The member at `index`, or `undefined` out of range. */
  at(index: number): T | undefined {
    return this.#list.get(index);
  }
  /** The first member, or `undefined` when empty. */
  first(): T | undefined {
    return this.#list.get(0);
  }
  /** The last member, or `undefined` when empty. */
  last(): T | undefined {
    return this.#list.get(this.#list.length - 1);
  }

  /** Append `value` (interned on entry). Returns `this` if a structural equal is present. */
  add(value: T): OrderedSet<T> {
    const v = intern(value);
    const h = internHash(v);
    if (trieGet(CFG, this.#root, h, v) !== NOT_FOUND) return this;
    const { result: list, consed } = ValueList._record(() => this.#list.push(v));
    const root = trieInsert(CFG, this.#root, 0, h, [v, _ANCHOR_TAIL])!.node;
    return OrderedSet.#of<T>(list, this.#reanchor(root, list, consed));
  }

  /** Remove a structurally equal `value`. Returns `this` if absent. */
  delete(value: T): OrderedSet<T> {
    const v = intern(value);
    const h = internHash(v);
    if (trieGet(CFG, this.#root, h, v) === NOT_FOUND) return this;
    const i = ValueList._indexOf(this.#list, v, (k) => this.#anchor(k));
    if (i < 0) throw new Error('valsem: OrderedSet anchors are inconsistent (this is a bug)');
    const { result: list, consed } = ValueList._record(() => this.#list.remove(i));
    const root = trieRemove(CFG, this.#root, 0, h, v)!.node as HNode;
    return OrderedSet.#of<T>(list, this.#reanchor(root, list, consed));
  }

  /**
   * Insert a new member before `index` (0 ≤ index ≤ size). Throws if a
   * structural equal is already a member — a member has one position;
   * delete it first to move it.
   */
  insertAt(index: number, value: T): OrderedSet<T> {
    const n = this.#list.length;
    if (!Number.isInteger(index) || index < 0 || index > n) {
      throw new RangeError(`OrderedSet.insertAt: index ${index} out of range [0, ${n}]`);
    }
    const v = intern(value);
    const h = internHash(v);
    if (trieGet(CFG, this.#root, h, v) !== NOT_FOUND) {
      throw new Error('valsem: OrderedSet.insertAt: the value is already a member — delete it first to move it');
    }
    if (index === n) return this.add(v);
    const { result: list, consed } = ValueList._record(() => this.#list.insert(index, v));
    const root = trieInsert(CFG, this.#root, 0, h, [v, _ANCHOR_TAIL])!.node;
    return OrderedSet.#of<T>(list, this.#reanchor(root, list, consed));
  }

  /** Iterate the members in order. */
  values(): SetIterator<T> {
    return this.#list[Symbol.iterator]() as unknown as SetIterator<T>;
  }
  /** Alias of {@link values}, as `ReadonlySet.keys` is. */
  keys(): SetIterator<T> {
    return this.values();
  }
  /** Iterate `[value, value]` pairs in order, as `ReadonlySet.entries` does. */
  entries(): SetIterator<[T, T]> {
    return new PairIterator<T>(this.#list[Symbol.iterator]()) as unknown as SetIterator<[T, T]>;
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }
  /** Call `fn` for each member in order, as `ReadonlySet.forEach` does. */
  forEach(fn: (value: T, value2: T, set: OrderedSet<T>) => void, thisArg?: unknown): void {
    this.#list.forEach((v) => fn.call(thisArg, v, v, this));
  }

  /** The `produce` draft protocol: a {@link DraftOrderedSet} over this set. */
  [toDraft](parent?: DraftState): OrderedSetState<T> {
    return createOrderedSetDraft(this, parent, OrderedSet.empty);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty set. */
  static empty<T>(): OrderedSet<T> {
    return OrderedSet.#of<T>(ValueList.empty<T>(), CFG.empty);
  }

  /** The canonical ordered set of `values`, in first-occurrence order (interned on entry). */
  static of<T>(...values: T[]): OrderedSet<T> {
    return OrderedSet.from(values);
  }

  /**
   * The canonical ordered set of the distinct members of `values`, in order
   * of first occurrence (interned on entry). Built in one pass: the member
   * list once, and every anchor read off the nodes that pass consed.
   */
  static from<T>(values: Iterable<T>): OrderedSet<T> {
    const members: unknown[] = [];
    const seen = new Set<unknown>();
    for (const raw of values) {
      const v = intern(raw);
      // SameValueZero, as the trie compares: NaN is one member.
      const key = v !== v ? NaN : v;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(v);
    }
    if (members.length === 0) return OrderedSet.empty<T>();
    const { result: list, consed } = ValueList._record(() => ValueList.from(members as T[]));
    const anchors = anchorsFor(members, ValueList._anchorUpdates(consed, list));
    return OrderedSet.#of<T>(list, trieFrom(CFG, members, anchors));
  }
}
