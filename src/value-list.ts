// ---------------------------------------------------------------------------
// ValueList — persistent (immutable) list on a hash-consed dense radix vector
//
// Dense radix vector (Clojure PersistentVector shape), NOT an RRB tree: the
// tree shape is a pure function of the length — trunk of full 32-wide leaves
// under a left-complete 32-ary branch structure, plus a tail of the last
// 1..32 elements — which is exactly what hash consing requires. Every node
// (trunk leaves, branches, and the tail, which is itself a leaf node) is
// interned through a weak pool: children cons before parents, so
// equal content converges on the same nodes process-wide, however it was
// built (push sequences, from(), set/pop detours — all one canonical
// instance), and [equals] is two pointer comparisons (root and tail).
//
// Elements are **interned on entry** (push/set/from): everything stored is a
// canonical value or primitive, so structurally equal raw inputs converge on
// one canonical list, and a stored element can never be mutated out from
// under its cached hashes. The representation is a #private tree; the old
// public `.array` is retired (there is no longer a platform-enforceable flat
// representation to expose). `toArray()` materializes the interned flat
// array on demand — O(n), weakly memoized per instance.
//
// RRB-style O(1) concat/slice is deliberately absent: relaxed nodes make the
// shape history-dependent, which breaks canonical form — and plain arrays
// are equally bad at those operations, so omitting them violates no
// expectation.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { intern, internHash } from './intern.js';

const BITS = 5;
const WIDTH = 32;
const MASK = 31;

/** A consed vector node: elements (leaf / tail) or child nodes (branch). */
interface VNode {
  readonly h: number;
  readonly slots: readonly unknown[];
}

/** Ordered hash combine — boost-style. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

/** SameValueZero. */
function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

function slotsSame(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

const vpool = createInternPool<VNode>();

function consLeaf(slots: unknown[]): VNode {
  let h = mix(0x1eaf, slots.length);
  for (let i = 0; i < slots.length; i++) h = mix(h, internHash(slots[i]));
  const found = vpool.lookup(h, (c) => slotsSame(c.slots, slots));
  if (found !== undefined) return found;
  return vpool.register({ h, slots }, h);
}

function consBranch(slots: VNode[]): VNode {
  let h = mix(0xb4a9c4, slots.length);
  for (let i = 0; i < slots.length; i++) h = mix(h, slots[i]!.h);
  const found = vpool.lookup(h, (c) => slotsSame(c.slots, slots));
  if (found !== undefined) return found;
  return vpool.register({ h, slots }, h);
}

const EMPTY_TAIL = consLeaf([]);

// ---------------------------------------------------------------------------
// Trunk operations (leaf level is shift 0; the root sits at the list's #shift)
// ---------------------------------------------------------------------------

function trunkGet(node: VNode, shift: number, i: number): unknown {
  let n = node;
  let s = shift;
  while (s > 0) {
    n = n.slots[(i >>> s) & MASK] as VNode;
    s -= BITS;
  }
  return n.slots[i & MASK];
}

function trunkSet(node: VNode, shift: number, i: number, v: unknown): VNode {
  if (shift === 0) {
    const slots = node.slots.slice();
    slots[i & MASK] = v;
    return consLeaf(slots);
  }
  const si = (i >>> shift) & MASK;
  const slots = node.slots.slice();
  slots[si] = trunkSet(node.slots[si] as VNode, shift - BITS, i, v);
  return consBranch(slots as VNode[]);
}

/** A minimal spine from `shift` down to one leaf. */
function newPath(shift: number, leaf: VNode): VNode {
  return shift === 0 ? leaf : consBranch([newPath(shift - BITS, leaf)]);
}

/** Append a full leaf whose first element lands at trunk index `at` (root not full). */
function pushLeaf(node: VNode, shift: number, at: number, leaf: VNode): VNode {
  const si = (at >>> shift) & MASK;
  const slots = node.slots.slice();
  if (shift === BITS) {
    slots[si] = leaf; // si === slots.length: append position
  } else {
    slots[si] =
      si < node.slots.length
        ? pushLeaf(node.slots[si] as VNode, shift - BITS, at, leaf)
        : newPath(shift - BITS, leaf);
  }
  return consBranch(slots as VNode[]);
}

/** Detach the last leaf (containing trunk index `lastIdx`). */
function popLeaf(node: VNode, shift: number, lastIdx: number): [VNode | null, VNode] {
  if (shift === 0) return [null, node]; // the root itself is the last leaf
  const si = (lastIdx >>> shift) & MASK; // === node.slots.length - 1
  if (shift === BITS) {
    const leaf = node.slots[si] as VNode;
    if (si === 0) return [null, leaf];
    return [consBranch(node.slots.slice(0, si) as VNode[]), leaf];
  }
  const [child, leaf] = popLeaf(node.slots[si] as VNode, shift - BITS, lastIdx);
  if (child === null) {
    if (si === 0) return [null, leaf];
    return [consBranch(node.slots.slice(0, si) as VNode[]), leaf];
  }
  const slots = node.slots.slice();
  slots[si] = child;
  return [consBranch(slots as VNode[]), leaf];
}

function* trunkElements(node: VNode, shift: number): Generator<unknown> {
  if (shift === 0) {
    yield* node.slots;
    return;
  }
  for (const c of node.slots) yield* trunkElements(c as VNode, shift - BITS);
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

const lpool = createInternPool<ValueList<unknown>>();

/** toArray() memo — one weakly-held snapshot per instance. */
const snapshots = new WeakMap<ValueList<unknown>, WeakRef<readonly unknown[]>>();

/**
 * Persistent (immutable) list with structural identity.
 *
 * Elements are **interned on entry**, so two `ValueList` instances with
 * structurally equal contents are the same object reference — lineage-free,
 * because the backing radix vector is hash-consed: lists built by pushes, by
 * `from()`, or through set/pop detours converge on one canonical instance,
 * and deep equality is two pointer comparisons. Raw plain-data elements are
 * canonicalized (and frozen) the way `intern()` does; what `get(i)` returns
 * is the canonical instance.
 *
 * Element access is `get(i)` (O(log₃₂ n) — a few array hops), iteration
 * streams the tree in index order, and `toArray()` materializes a frozen
 * snapshot (O(n), weakly memoized per instance). Updates (`push`/`pop`/
 * `set`) path-copy O(log n) nodes and share the rest.
 */
export class ValueList<T> {
  /** Trunk root (full 32-wide leaves), or null when everything fits the tail. */
  readonly #root: VNode | null;
  /** Root height in bits; 0 means the root is a single leaf. Always 0 when #root is null. */
  readonly #shift: number;
  /** The last 1..32 elements (a consed leaf node; empty only for the empty list). */
  readonly #tail: VNode;
  readonly #length: number;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;

  private constructor(root: VNode | null, shift: number, tail: VNode, length: number) {
    this.#root = root;
    this.#shift = shift;
    this.#tail = tail;
    this.#length = length;
    this[hashCodeSym] = mix(mix(0x11f7, root === null ? 0 : root.h), tail.h);
    Object.freeze(this); // protects the cached [hashCode] too
  }

  static #of<T>(root: VNode | null, shift: number, tail: VNode, length: number): ValueList<T> {
    const h = mix(mix(0x11f7, root === null ? 0 : root.h), tail.h);
    const found = lpool.lookup(h, (c) => c.#root === root && c.#tail === tail);
    if (found !== undefined) return found as ValueList<T>;
    return lpool.register(new ValueList<unknown>(root, shift, tail, length), h) as ValueList<T>;
  }

  /** Number of elements. */
  get length(): number {
    return this.#length;
  }

  /** Elements in the trunk (everything not in the tail). */
  get #trunkLen(): number {
    return this.#length - this.#tail.slots.length;
  }

  /** The element at `index`, or `undefined` out of range. */
  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.#length) return undefined;
    const trunkLen = this.#trunkLen;
    if (index >= trunkLen) return this.#tail.slots[index - trunkLen] as T;
    return trunkGet(this.#root!, this.#shift, index) as T;
  }

  /** Iterate the elements in index order. */
  *[Symbol.iterator](): IterableIterator<T> {
    if (this.#root !== null) yield* trunkElements(this.#root, this.#shift) as Generator<T>;
    yield* this.#tail.slots as readonly T[];
  }

  /**
   * The **interned** flat-array snapshot of the elements — O(n) on first
   * call, weakly memoized per instance. Elements are already canonical
   * (interned on entry), so `toArray()[i] === get(i)` always, and the
   * cross-representation unity `list.toArray() === intern([...sameContents])`
   * holds: one canonical flat array per list value, process-wide.
   */
  toArray(): readonly T[] {
    const memo = snapshots.get(this as ValueList<unknown>)?.deref();
    if (memo !== undefined) return memo as readonly T[];
    const out = intern([...this]) as readonly T[];
    snapshots.set(this as ValueList<unknown>, new WeakRef(out));
    return out;
  }

  [equalsSym](other: unknown): boolean {
    // Hash consing makes deep equality two pointer comparisons.
    return (
      other instanceof ValueList &&
      (other as ValueList<T>).#root === this.#root &&
      (other as ValueList<T>).#tail === this.#tail
    );
  }

  /** Append `value` (interned on entry). Returns the canonical successor. */
  push(value: T): ValueList<T> {
    value = intern(value);
    const tailSlots = this.#tail.slots;
    if (tailSlots.length < WIDTH) {
      const newTail = consLeaf([...tailSlots, value]);
      return ValueList.#of<T>(this.#root, this.#shift, newTail, this.#length + 1);
    }
    // Tail is full: it becomes the trunk's next leaf.
    const trunkLen = this.#trunkLen;
    let root: VNode;
    let shift: number;
    if (this.#root === null) {
      root = this.#tail;
      shift = 0;
    } else if (trunkLen === WIDTH << this.#shift) {
      // Root is full — grow a level.
      root = consBranch([this.#root, newPath(this.#shift, this.#tail)]);
      shift = this.#shift + BITS;
    } else {
      root = pushLeaf(this.#root, this.#shift, trunkLen, this.#tail);
      shift = this.#shift;
    }
    return ValueList.#of<T>(root, shift, consLeaf([value]), this.#length + 1);
  }

  /** Remove the last element. Returns `this` on the empty list. */
  pop(): ValueList<T> {
    if (this.#length === 0) return this;
    const tailSlots = this.#tail.slots;
    if (tailSlots.length > 1) {
      return ValueList.#of<T>(this.#root, this.#shift, consLeaf(tailSlots.slice(0, -1)), this.#length - 1);
    }
    if (this.#root === null) return ValueList.empty<T>();
    // The tail empties: pull the trunk's last leaf back out as the new tail.
    const trunkLen = this.#length - 1;
    const newTrunkLen = trunkLen - WIDTH;
    const [popped, leaf] = popLeaf(this.#root, this.#shift, trunkLen - 1);
    let root = popped;
    let shift = root === null ? 0 : this.#shift;
    if (root !== null && shift > 0 && newTrunkLen <= WIDTH << (shift - BITS)) {
      root = root.slots[0] as VNode; // single-child root collapses a level
      shift -= BITS;
    }
    return ValueList.#of<T>(root, shift, leaf, this.#length - 1);
  }

  /** Replace the element at `index` (interned on entry). Returns the canonical successor. */
  set(index: number, value: T): ValueList<T> {
    if (!Number.isInteger(index) || index < 0 || index >= this.#length) {
      throw new RangeError(`ValueList.set: index ${index} out of range [0, ${this.#length})`);
    }
    value = intern(value);
    const trunkLen = this.#trunkLen;
    if (index >= trunkLen) {
      const ti = index - trunkLen;
      if (same(this.#tail.slots[ti], value)) return this;
      const slots = this.#tail.slots.slice();
      slots[ti] = value;
      return ValueList.#of<T>(this.#root, this.#shift, consLeaf(slots), this.#length);
    }
    if (same(trunkGet(this.#root!, this.#shift, index), value)) return this;
    const root = trunkSet(this.#root!, this.#shift, index, value);
    return ValueList.#of<T>(root, this.#shift, this.#tail, this.#length);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty list. */
  static empty<T>(): ValueList<T> {
    return ValueList.#of<T>(null, 0, EMPTY_TAIL, 0);
  }

  /** Canonical ValueList for the given items (compared element-wise via SameValueZero). */
  static of<T>(...items: T[]): ValueList<T> {
    return ValueList.from(items);
  }

  /** Canonical ValueList for the given iterable (elements interned on entry). */
  static from<T>(items: Iterable<T> | ArrayLike<T>): ValueList<T> {
    // Spread frozen arrays: V8's slice fast path skips frozen elements.
    const arr: T[] = Array.isArray(items)
      ? Object.isFrozen(items)
        ? ([...(items as readonly T[])] as T[])
        : (items.slice() as T[])
      : Array.from(items as Iterable<T>);
    const len = arr.length;
    if (len === 0) return ValueList.empty<T>();
    for (let i = 0; i < len; i++) arr[i] = intern(arr[i]!);
    // Trunk/tail split is a pure function of the length: the tail holds the
    // last ((len − 1) % 32) + 1 elements, the trunk the (multiple-of-32) rest.
    const trunkLen = ((len - 1) >>> BITS) << BITS;
    const tail = consLeaf(arr.slice(trunkLen));
    if (trunkLen === 0) return ValueList.#of<T>(null, 0, tail, len);
    // Left-complete bottom-up build — identical shape to push construction.
    let level: VNode[] = [];
    for (let i = 0; i < trunkLen; i += WIDTH) level.push(consLeaf(arr.slice(i, i + WIDTH)));
    let shift = 0;
    while (level.length > 1) {
      const up: VNode[] = [];
      for (let i = 0; i < level.length; i += WIDTH) up.push(consBranch(level.slice(i, i + WIDTH)));
      level = up;
      shift += BITS;
    }
    return ValueList.#of<T>(level[0]!, shift, tail, len);
  }

  /** @internal Node/wrapper pool sizes — exposed for sharing tests. */
  static _nodeStats(): { vnodes: number; wrappers: number } {
    return { vnodes: vpool.size(), wrappers: lpool.size() };
  }
}
