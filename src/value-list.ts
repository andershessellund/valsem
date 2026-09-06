// ---------------------------------------------------------------------------
// ValueList — persistent list on a content-chunked, hash-consed tree.
//
// (Replaced the dense radix vector at v0.0.2: same canonical-identity
// promise, O(log n) inserts/removes/concat/slice instead of O(n), and a
// sublinear diff. The measurements are in BENCHMARKS.md.)
//
// Leaves hold runs of elements; a run ends after an element whose hash says
// "boundary" (a 1-in-32 event) or at 64 elements. Branches hold runs of
// nodes under the same rule on node hashes (with at least two per run, so
// every level shrinks). Because every boundary is a property of the content
// beside it, the tree's shape is a function of the sequence alone — which is
// what hash consing needs: equal content is the same node, however it was
// built — and an edit disturbs only the runs around it, resynchronising with
// the untouched remainder at the next boundary. That gives O(log n) expected
// insert, remove, concat and slice (a radix vector rebuilds O(n)), and a
// diff between ANY two lists in O(c log n) expected for c changes, related
// or not, by skipping shared nodes.
//
// The price: `get` walks size tables instead of shifting bits, and the
// bounds are expected, on the seeded hash — an adversary who does not know
// the seed cannot craft a bad sequence, and there is no amortised rebuild
// anywhere: every operation is a path of local re-chunks.
//
// Everything below is one algorithm, `merge`: given a left context (the path
// to a cut in this list), head elements, and a cursor over a right context
// (the remainder of a list after a cut), re-chunk level by level until each
// level resynchronises with the right context's existing nodes. `from`,
// `push`, `splice`, `concat` and `slice` are all calls to it.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { intern, internHash } from './intern.js';
import { toDraft, type DraftState } from './draft-core.js';
import { createListDraft, type ListState } from './draft-list.js';

/** A consed node: `kids` are elements (height 1) or nodes (height > 1). */
interface CNode {
  readonly h: number;
  /** Elements covered. */
  readonly n: number;
  /** 1 for a leaf. */
  readonly ht: number;
  readonly kids: readonly unknown[];
  /** Branch only: start offset of each kid. */
  readonly offsets: readonly number[] | null;
}

/** Ordered hash combine — boost-style. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

const MAX_RUN = 64;

/** Does an element with hash `h` end a leaf run? (1 in 32.) */
function itemBoundary(h: number): boolean {
  return Math.imul(h, 0x9e3779b1) >>> 27 === 0;
}
/** Does node `k` end a branch run? (1 in 32; a run holds at least two.) */
function nodeBoundary(k: CNode): boolean {
  return Math.imul(k.h ^ 0x5bd1e995, 0x9e3779b1) >>> 27 === 0;
}

function kidsSame(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

const cpool = createInternPool<CNode>();

function consLeaf(items: unknown[], hashes: number[]): CNode {
  let h = mix(0xc1ea, items.length);
  for (let i = 0; i < hashes.length; i++) h = mix(h, hashes[i]!);
  const found = cpool.lookup(h, (c) => c.ht === 1 && kidsSame(c.kids, items));
  if (found !== undefined) return found;
  return cpool.register({ h, n: items.length, ht: 1, kids: items, offsets: null }, h);
}

function consBranch(kids: CNode[]): CNode {
  let h = mix(0xb4a9c4, kids.length);
  let n = 0;
  const offsets = new Array<number>(kids.length);
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    h = mix(h, k.h);
    offsets[i] = n;
    n += k.n;
  }
  const ht = kids[0]!.ht + 1;
  const found = cpool.lookup(h, (c) => c.ht === ht && kidsSame(c.kids, kids));
  if (found !== undefined) return found;
  return cpool.register({ h, n, ht, kids, offsets }, h);
}

// ---------------------------------------------------------------------------
// Cursors — a walk over the level-k elements of a tree from a start point
// ---------------------------------------------------------------------------

interface Frame {
  node: CNode;
  i: number;
}

/** A synthetic parent above a root, so the root is an element like any other. */
function superRoot(root: CNode): CNode {
  return { h: 0, n: root.n, ht: root.ht + 1, kids: [root], offsets: [0] };
}

/**
 * Yields, in order, the height-`k` elements of a tree that lie after a start
 * point, each tagged with whether it is the first kid of its parent — the
 * points at which a re-chunk can resynchronise and reuse the parent and
 * everything after it.
 */
class Cursor {
  readonly stack: Frame[];
  k: number;
  constructor(stack: Frame[], k: number) {
    this.stack = stack;
    this.k = k;
  }

  /** Position the stack on the next element without consuming it; null at the end. */
  peek(): { el: unknown; first: boolean } | null {
    const s = this.stack;
    while (s.length !== 0) {
      const top = s[s.length - 1]!;
      if (top.i >= top.node.kids.length) {
        s.pop();
        continue;
      }
      if (top.node.ht === this.k + 1) {
        return { el: top.node.kids[top.i], first: top.i === 0 && top.node.h !== 0 };
      }
      s.push({ node: top.node.kids[top.i] as CNode, i: 0 });
      top.i++;
    }
    return null;
  }

  consume(): void {
    this.stack[this.stack.length - 1]!.i++;
  }

  /** After a resync right before a first kid: move up one level so its parent is the next element. */
  ascend(): void {
    this.stack.pop();
    const gp = this.stack[this.stack.length - 1];
    if (gp !== undefined) gp.i--;
    this.k++;
  }

  exhausted(): boolean {
    return this.peek() === null;
  }
}

/** A level-0 cursor over all of `root`. */
function cursorFromStart(root: CNode | null): Cursor | null {
  return root === null ? null : new Cursor([{ node: superRoot(root), i: 0 }], 0);
}

// ---------------------------------------------------------------------------
// merge — the one algorithm
// ---------------------------------------------------------------------------

/**
 * The path to element index `i` (0 ≤ i ≤ n): frames from the root down to
 * the leaf, each `i` the kid index on the path; `off` is the index within
 * the leaf. `i === n` lands on the last leaf with `off === leaf.n`.
 */
function pathTo(root: CNode, i: number): { frames: Frame[]; leaf: CNode; off: number } {
  const frames: Frame[] = [];
  let node = root;
  let rem = i;
  while (node.ht > 1) {
    const off = node.offsets!;
    // largest j with off[j] <= rem, but never past the last kid (rem === n lands on it)
    let lo = 0;
    let hi = off.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (off[mid]! <= rem) lo = mid;
      else hi = mid - 1;
    }
    frames.push({ node, i: lo });
    rem -= off[lo]!;
    node = node.kids[lo] as CNode;
  }
  return { frames, leaf: node, off: rem };
}

/**
 * Re-chunk from a cut. `frames` is the left context: the path to the cut in
 * the list being edited (kids before each frame's `i` are kept, the frame's
 * kid at `i` is the one being re-chunked); `head` is the leaf-level content
 * starting at the cut (the cut leaf's kept prefix, the inserted elements,
 * and the kept suffix of the right cut leaf), already interned; `cursor` is
 * the right context: the level-0 elements after the right cut, or null.
 */
function merge(frames: Frame[], head: unknown[], cursor: Cursor | null): CNode | null {
  // ---- level 0: elements → leaves
  let out: CNode[] = [];
  {
    let items: unknown[] = [];
    let hashes: number[] = [];
    const feed = (el: unknown): void => {
      const h = internHash(el);
      items.push(el);
      hashes.push(h);
      if (itemBoundary(h) || items.length >= MAX_RUN) {
        out.push(consLeaf(items, hashes));
        items = [];
        hashes = [];
      }
    };
    for (let i = 0; i < head.length; i++) feed(head[i]);
    if (cursor !== null) {
      for (;;) {
        const nx = cursor.peek();
        if (nx === null) {
          cursor = null;
          break;
        }
        if (items.length === 0 && nx.first) {
          cursor.ascend(); // resync: the rest of this leaf level is B's own
          break;
        }
        cursor.consume();
        feed(nx.el);
      }
    }
    if (items.length !== 0) out.push(consLeaf(items, hashes));
  }

  // ---- levels 1..: nodes → branches
  for (let k = 1; ; k++) {
    // Left context at this level: the kept kids of the frame of height k+1.
    const fi = frames.length - k; // frames[fi] has height k+1 (frames[last] is the leaf's parent)
    const frame = fi >= 0 ? frames[fi]! : undefined;
    const headNodes: CNode[] = frame !== undefined ? (frame.node.kids.slice(0, frame.i) as CNode[]) : [];
    for (let i = 0; i < out.length; i++) headNodes.push(out[i]!);
    let leftAbove = false;
    for (let j = 0; j < fi; j++) if (frames[j]!.i > 0) leftAbove = true;
    const rightMore = cursor !== null && !cursor.exhausted();
    if (headNodes.length === 0 && !leftAbove && !rightMore) return null;
    if (headNodes.length === 1 && !leftAbove && !rightMore) return headNodes[0]!;

    out = [];
    let run: CNode[] = [];
    const feed = (nd: CNode): void => {
      run.push(nd);
      if ((run.length >= 2 && nodeBoundary(nd)) || run.length >= MAX_RUN) {
        out.push(consBranch(run));
        run = [];
      }
    };
    for (let i = 0; i < headNodes.length; i++) feed(headNodes[i]!);
    if (cursor !== null) {
      for (;;) {
        const nx = cursor.peek();
        if (nx === null) {
          cursor = null;
          break;
        }
        if (run.length === 0 && nx.first) {
          cursor.ascend();
          break;
        }
        cursor.consume();
        feed(nx.el as CNode);
      }
    }
    if (run.length !== 0) out.push(consBranch(run));
  }
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const lpool = createInternPool<ValueList<unknown>>();

/** Weak memo of `toArray()` snapshots per instance. */
const snapshots = new WeakMap<ValueList<unknown>, WeakRef<readonly unknown[]>>();
/** Weak memo of the attached (single-root) tree per instance — what the structural operations work on. */
const fulls = new WeakMap<ValueList<unknown>, CNode>();

/** One changed region between two lists: `[aStart, aEnd)` in `a` became `[bStart, bEnd)` in `b`. */
export interface Hunk {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

/** Is a leaf holding `items` closed — does its run end on its own, not merely at the list end? */
function leafClosed(items: readonly unknown[]): boolean {
  return items.length >= MAX_RUN || itemBoundary(internHash(items[items.length - 1]));
}

/**
 * Persistent (immutable) list whose instances are canonical: equal content
 * is the same object, however built. Elements are interned on entry.
 * `push`, `pop`, `set`, `insert`, `remove`, `splice`, `slice` and `concat`
 * are O(log n) expected (`setMany` batches point edits), and
 * `ValueList.diff(a, b)` finds the changed regions between any two lists in
 * O(c log n) expected for c changes.
 *
 * Representation: the tree holds every CLOSED run; the last run, while it
 * is still open (no boundary element at its end, under 64 elements), lives
 * in `#tail` as a plain array — so `push` and `pop` are an array copy, and
 * the tree is touched only when a run closes. The split is canonical: the
 * open run is exactly what the chunker would leave open at the end.
 */
export class ValueList<T> implements Iterable<T> {
  /** Closed runs only; null when there are none. */
  readonly #root: CNode | null;
  /** The open last run (canonical elements), possibly empty. */
  readonly #tail: readonly unknown[];
  readonly #hash: number;
  /** The leaf of the last `get`, with its index range — sequential reads stay in one leaf. */
  readonly #last: { start: number; end: number; leaf: CNode | null };

  private constructor(root: CNode | null, tail: readonly unknown[], hash: number) {
    this.#root = root;
    this.#tail = tail;
    this.#hash = hash;
    this.#last = { start: 0, end: 0, leaf: null };
    Object.freeze(this);
  }

  get [hashCodeSym](): number {
    return this.#hash;
  }
  get [internedSym](): true {
    return true;
  }
  [equalsSym](other: unknown): boolean {
    // Hash consing makes deep equality one pointer comparison.
    return other === this;
  }

  static #hashOf(root: CNode | null, tail: readonly unknown[]): number {
    let h = mix(0xc4a1, root === null ? 0 : root.h);
    h = mix(h, tail.length);
    for (let i = 0; i < tail.length; i++) h = mix(h, internHash(tail[i]));
    return h;
  }

  /** The canonical list for a (closed tree, open tail) pair — the pair must already be normalised. */
  static #of<T>(root: CNode | null, tail: readonly unknown[]): ValueList<T> {
    const h = ValueList.#hashOf(root, tail);
    const found = lpool.lookup(h, (c) => c.#root === root && kidsSame(c.#tail, tail));
    if (found !== undefined) return found as ValueList<T>;
    return lpool.register(new ValueList<unknown>(root, tail, h), h) as ValueList<T>;
  }

  /** The canonical list for a whole tree: detach its last leaf into the tail if that run is open. */
  static #fromFull<T>(full: CNode | null): ValueList<T> {
    if (full === null) return ValueList.#of<T>(null, []);
    const p = pathTo(full, full.n); // rightmost path; leaf = last leaf
    if (leafClosed(p.leaf.kids)) return ValueList.#of<T>(full, []);
    const list = ValueList.#of<T>(detachLast(p.frames), p.leaf.kids);
    fulls.set(list as ValueList<unknown>, full); // the next structural op needs no re-attach
    return list;
  }

  /** The whole content as one tree — the tail attached — memoized per instance. */
  #full(): CNode | null {
    if (this.#tail.length === 0) return this.#root;
    const memo = fulls.get(this as ValueList<unknown>);
    if (memo !== undefined) return memo;
    const root = this.#root;
    let full: CNode;
    if (root === null) full = merge([], this.#tail.slice(), null)!;
    else {
      const p = pathTo(root, root.n);
      const head = p.leaf.kids.slice();
      for (let i = 0; i < this.#tail.length; i++) head.push(this.#tail[i]);
      full = merge(p.frames, head, null)!;
    }
    fulls.set(this as ValueList<unknown>, full);
    return full;
  }

  static empty<T>(): ValueList<T> {
    return ValueList.#of<T>(null, []);
  }

  static of<T>(...items: T[]): ValueList<T> {
    return ValueList.from(items);
  }

  /** The canonical list for `items` (elements interned on entry). */
  static from<T>(items: Iterable<T> | ArrayLike<T>): ValueList<T> {
    const arr = Array.isArray(items) ? items : Array.from(items as Iterable<T>);
    const head = new Array<unknown>(arr.length);
    for (let i = 0; i < arr.length; i++) head[i] = intern(arr[i]);
    return ValueList.#fromFull<T>(merge([], head, null));
  }

  get length(): number {
    return (this.#root === null ? 0 : this.#root.n) + this.#tail.length;
  }

  get(index: number): T | undefined {
    const root = this.#root;
    const trunk = root === null ? 0 : root.n;
    if (index < 0 || index >= trunk + this.#tail.length) return undefined;
    if (index >= trunk) return this.#tail[index - trunk] as T;
    const last = this.#last;
    if (index >= last.start && index < last.end) return last.leaf!.kids[index - last.start] as T;
    let node = root!;
    let rem = index;
    while (node.ht > 1) {
      const off = node.offsets!;
      let lo = 0;
      let hi = off.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (off[mid]! <= rem) lo = mid;
        else hi = mid - 1;
      }
      rem -= off[lo]!;
      node = node.kids[lo] as CNode;
    }
    last.start = index - rem;
    last.end = last.start + node.n;
    last.leaf = node;
    return node.kids[rem] as T;
  }

  /** Append `value` (interned on entry). An array copy of the open run; the tree is touched only when the run closes. */
  push(value: T): ValueList<T> {
    const v = intern(value);
    const tail = this.#tail.slice();
    tail.push(v);
    if (!leafClosed(tail)) return ValueList.#of<T>(this.#root, tail);
    // The run closed: it joins the tree as a leaf, re-chunking the levels above.
    const root = this.#root;
    const full = root === null ? merge([], tail, null) : merge(pathTo(root, root.n).frames, [...pathTo(root, root.n).leaf.kids, ...tail], null);
    return ValueList.#of<T>(full, []);
  }

  pop(): ValueList<T> {
    if (this.#tail.length !== 0) return ValueList.#of<T>(this.#root, this.#tail.slice(0, -1));
    const root = this.#root;
    if (root === null) return this;
    // The tree's last leaf is closed; shorten it, and it becomes the open tail unless it closes on its own again.
    const p = pathTo(root, root.n);
    const items = p.leaf.kids.slice(0, -1);
    if (items.length === 0) return ValueList.#of<T>(detachLast(p.frames), []);
    if (leafClosed(items)) return ValueList.#of<T>(replaceLast(p.frames, consLeaf(items, items.map((x) => internHash(x)))), []);
    return ValueList.#of<T>(detachLast(p.frames), items);
  }

  /**
   * Replace `deleteCount` elements at `start` with `items` — the general
   * edit; O(log n) expected. `insert`, `remove`, `concat` and `slice` are
   * all this.
   */
  splice(start: number, deleteCount: number, items: readonly T[] = []): ValueList<T> {
    const n = this.length;
    if (start < 0) start = Math.max(0, n + start);
    if (start > n) start = n;
    const end = Math.min(n, start + Math.max(0, deleteCount));
    const root = this.#full();
    if (root === null) return ValueList.from(items);
    const s = pathTo(root, start);
    const e = end === start ? s : pathTo(root, end);
    const head: unknown[] = s.leaf.kids.slice(0, s.off);
    for (let i = 0; i < items.length; i++) head.push(intern(items[i]));
    for (let i = e.off; i < e.leaf.n; i++) head.push(e.leaf.kids[i]);
    const stack: Frame[] = [{ node: superRoot(root), i: 1 }];
    for (let i = 0; i < e.frames.length; i++) {
      const f = e.frames[i]!;
      stack.push({ node: f.node, i: f.i + 1 });
    }
    const result = merge(s.frames, head, new Cursor(stack, 0));
    return result === root ? this : ValueList.#fromFull<T>(result);
  }

  /**
   * Replace one element; O(log n). In the open tail it is an array copy;
   * in the tree, when neither the old nor the new element flips a boundary
   * at any level, a plain path copy; otherwise the general splice.
   */
  set(index: number, value: T): ValueList<T> {
    const n = this.length;
    if (index < 0 || index >= n) throw new RangeError(`ValueList.set: index ${index} out of range`);
    const v = intern(value);
    const root = this.#root;
    const trunk = root === null ? 0 : root.n;
    if (index >= trunk) {
      const j = index - trunk;
      const old = this.#tail[j];
      if (old === v || (old !== old && v !== v)) return this;
      const tail = this.#tail.slice();
      tail[j] = v;
      // A new boundary inside the tail closes it early; let the general path re-chunk.
      if (j !== tail.length - 1 && itemBoundary(internHash(v))) return this.splice(index, 1, [v]);
      if (leafClosed(tail)) return this.splice(index, 1, [v]);
      return ValueList.#of<T>(root, tail);
    }
    const p = pathTo(root!, index);
    const old = p.leaf.kids[p.off];
    if (old === v || (old !== old && v !== v)) return this;
    const hOld = internHash(old);
    const hNew = internHash(v);
    if (itemBoundary(hOld) !== itemBoundary(hNew)) return this.splice(index, 1, [v]);
    const items = p.leaf.kids.slice();
    items[p.off] = v;
    const hashes = new Array<number>(items.length);
    for (let i = 0; i < items.length; i++) hashes[i] = i === p.off ? hNew : internHash(items[i]);
    let node = consLeaf(items, hashes);
    let prev = p.leaf;
    for (let k = p.frames.length - 1; k >= 0; k--) {
      if (nodeBoundary(prev) !== nodeBoundary(node)) return this.splice(index, 1, [v]);
      const f = p.frames[k]!;
      const kids = f.node.kids.slice() as CNode[];
      kids[f.i] = node;
      prev = f.node;
      node = consBranch(kids);
    }
    return ValueList.#of<T>(node, this.#tail);
  }

  /**
   * Apply many point edits at once — `[index, value]` pairs, any order —
   * in one bottom-up pass: every touched leaf and ancestor is rebuilt once,
   * untouched siblings are fed through in O(1), and a run that spills past
   * its old node carries into the next. O(k log n) for k edits. What a
   * draft's finalize uses.
   */
  setMany(edits: readonly (readonly [number, T])[]): ValueList<T> {
    if (edits.length === 0) return this;
    const n = this.length;
    const sorted = edits.map(([i, v]) => [i, intern(v)] as [number, unknown]).sort((a, b) => a[0] - b[0]);
    const idx: number[] = [];
    const vals: unknown[] = [];
    for (const [i, v] of sorted) {
      if (i < 0 || i >= n) throw new RangeError(`ValueList.setMany: index ${i} out of range`);
      if (idx.length !== 0 && idx[idx.length - 1] === i) vals[vals.length - 1] = v; // last write wins
      else {
        idx.push(i);
        vals.push(v);
      }
    }
    if (idx.length === 1) return this.set(idx[0]!, vals[0] as T); // the path-copy fast path
    const root = this.#full()!;
    const ed: EditStream = { idx, vals, pos: 0 };
    const carry: Carry = [];
    let top = rebuild(root, 0, ed, carry);
    // The list end closes every open run, bottom-up.
    for (let h = 0; h < root.ht; h++) {
      const open = carry[h];
      if (open === undefined || open === null || open.length === 0) continue;
      const node = h === 0 ? consLeaf(open, open.map((x) => internHash(x))) : consBranch(open as CNode[]);
      if (h + 1 === root.ht) top.push(node);
      else (carry[h + 1] ??= []).push(node);
    }
    while (top.length > 1) top = chunkLevel(top);
    let newRoot = top[0]!;
    while (newRoot.ht > 1 && newRoot.kids.length === 1) newRoot = newRoot.kids[0] as CNode; // a level of one node is the root
    return newRoot === root ? this : ValueList.#fromFull<T>(newRoot);
  }

  insert(index: number, value: T): ValueList<T> {
    return this.splice(index, 0, [value]);
  }
  remove(index: number): ValueList<T> {
    return this.splice(index, 1);
  }
  /** Elements `[start, end)`; O(log n) expected. */
  slice(start = 0, end = this.length): ValueList<T> {
    const n = this.length;
    if (start < 0) start = Math.max(0, n + start);
    if (end < 0) end = Math.max(0, n + end);
    end = Math.min(end, n);
    if (start >= end) return ValueList.empty<T>();
    return this.splice(end, n - end).splice(0, start);
  }
  /** This list followed by `other`; O(log n) expected. */
  concat(other: ValueList<T>): ValueList<T> {
    if (this.length === 0) return other;
    if (other.length === 0) return this;
    const root = this.#full()!;
    const p = pathTo(root, root.n);
    return ValueList.#fromFull<T>(merge(p.frames, p.leaf.kids.slice(), cursorFromStart(other.#full())));
  }

  /** Visit every element in index order. */
  forEach(fn: (value: T, index: number, list: ValueList<T>) => void, thisArg?: unknown): void {
    let index = 0;
    const walk = (node: CNode): void => {
      if (node.ht === 1) {
        for (let i = 0; i < node.kids.length; i++) fn.call(thisArg, node.kids[i] as T, index++, this);
      } else {
        for (let i = 0; i < node.kids.length; i++) walk(node.kids[i] as CNode);
      }
    };
    if (this.#root !== null) walk(this.#root);
    const tail = this.#tail;
    for (let i = 0; i < tail.length; i++) fn.call(thisArg, tail[i] as T, index++, this);
  }

  /**
   * The **interned** flat-array snapshot of the elements — O(n) on first
   * call, weakly memoized per instance. Elements are already canonical, so
   * `toArray()[i] === get(i)` always, and `list.toArray() === intern([...sameContents])`:
   * one canonical flat array per list value, process-wide.
   */
  toArray(): readonly T[] {
    const memo = snapshots.get(this as ValueList<unknown>)?.deref();
    if (memo !== undefined) return memo as readonly T[];
    const out: unknown[] = [];
    this.forEach((v) => out.push(v));
    const canonical = intern(out) as readonly T[];
    snapshots.set(this as ValueList<unknown>, new WeakRef(canonical));
    return canonical;
  }

  [Symbol.iterator](): ArrayIterator<T> {
    return new ChunkIterator<T>(this.#root, this.#tail) as unknown as ArrayIterator<T>;
  }

  /** The `produce` draft protocol: a {@link DraftList} over this list. */
  [toDraft](parent?: DraftState): ListState<T> {
    return createListDraft(this, parent);
  }

  /**
   * The changed regions between `a` and `b`, in order, as hunks — computed
   * by skipping every node the two trees share, so c edits cost O(c log n)
   * expected whether or not the lists are related. Each hunk is refined to
   * the elements by common prefix/suffix.
   */
  static diff<T>(a: ValueList<T>, b: ValueList<T>): Hunk[] {
    const out: Hunk[] = [];
    if (a === b) return out;
    const ra = a.#full();
    const rb = b.#full();
    let A: CNode[] = ra === null ? [] : [ra];
    let B: CNode[] = rb === null ? [] : [rb];
    const htA = A.length === 0 ? 0 : A[0]!.ht;
    const htB = B.length === 0 ? 0 : B[0]!.ht;
    while (A.length !== 0 && A[0]!.ht > htB && htB !== 0) A = A.flatMap((n) => n.kids as CNode[]);
    while (B.length !== 0 && B[0]!.ht > htA && htA !== 0) B = B.flatMap((n) => n.kids as CNode[]);
    const ht = A.length !== 0 ? A[0]!.ht : B.length !== 0 ? B[0]!.ht : 0;
    if (ht !== 0) diffRuns(A, B, ht, 0, 0, out);
    return out;
  }

  /** @internal */
  static _nodeStats(): { nodes: number; lists: number } {
    return { nodes: cpool.size(), lists: lpool.size() };
  }
  /** @internal Tree height of the closed part (0 for none). */
  get _height(): number {
    return this.#root === null ? 0 : this.#root.ht;
  }
}

/** The tree with its last leaf removed — path copies only (every node on the rightmost path closes at the list end regardless). */
function detachLast(frames: Frame[]): CNode | null {
  let node: CNode | null = null;
  for (let k = frames.length - 1; k >= 0; k--) {
    const f = frames[k]!;
    const kids = f.node.kids.slice(0, f.i) as CNode[];
    if (node !== null) kids.push(node);
    node = kids.length === 0 ? null : kids.length === 1 && k === 0 ? kids[0]! : consBranch(kids);
    if (node !== null && k === 0) while (node.ht > 1 && node.kids.length === 1) node = node.kids[0] as CNode;
  }
  return node;
}

/** The tree with its last leaf replaced by `leaf` — path copies only (same argument as detachLast). */
function replaceLast(frames: Frame[], leaf: CNode): CNode {
  let node: CNode = leaf;
  for (let k = frames.length - 1; k >= 0; k--) {
    const f = frames[k]!;
    const kids = f.node.kids.slice() as CNode[];
    kids[f.i] = node;
    node = consBranch(kids);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Batch rebuild — used by setMany
// ---------------------------------------------------------------------------

interface EditStream {
  readonly idx: number[];
  readonly vals: unknown[];
  pos: number;
}
/** `carry[h]`: the open run at height h (h = 0: elements) spilling from the previous sibling. */
type Carry = (unknown[] | null | undefined)[];

/** Re-chunk `node`'s content with the edits in its range applied; returns its closed replacement nodes, leaving open runs in `carry`. */
function rebuild(node: CNode, start: number, ed: EditStream, carry: Carry): CNode[] {
  const out: CNode[] = [];
  if (node.ht === 1) {
    let items: unknown[] = (carry[0] as unknown[] | undefined) ?? [];
    carry[0] = null;
    let hashes: number[] = items.map((x) => internHash(x));
    const feed = (el: unknown): void => {
      const h = internHash(el);
      items.push(el);
      hashes.push(h);
      if (itemBoundary(h) || items.length >= MAX_RUN) {
        out.push(consLeaf(items, hashes));
        items = [];
        hashes = [];
      }
    };
    const kids = node.kids;
    for (let i = 0; i < kids.length; i++) {
      if (ed.pos < ed.idx.length && ed.idx[ed.pos] === start + i) feed(ed.vals[ed.pos++]);
      else feed(kids[i]);
    }
    if (items.length !== 0) carry[0] = items;
    return out;
  }
  const h = node.ht - 1; // height of this node's kids
  let run: CNode[] = (carry[h] as CNode[] | undefined) ?? [];
  carry[h] = null;
  const feed = (nd: CNode): void => {
    run.push(nd);
    if ((run.length >= 2 && nodeBoundary(nd)) || run.length >= MAX_RUN) {
      out.push(consBranch(run));
      run = [];
    }
  };
  const kids = node.kids as readonly CNode[];
  const offsets = node.offsets!;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]!;
    const kidStart = start + offsets[i]!;
    const hasEdits = ed.pos < ed.idx.length && ed.idx[ed.pos]! < kidStart + kid.n;
    let lowerCarry = false;
    for (let j = 0; j < h; j++) {
      const c = carry[j];
      if (c !== undefined && c !== null && c.length !== 0) lowerCarry = true;
    }
    if (!hasEdits && !lowerCarry) {
      feed(kid); // untouched, and the scans below are fresh at its start: reused as-is
    } else {
      const nodes = rebuild(kid, kidStart, ed, carry);
      for (let k = 0; k < nodes.length; k++) feed(nodes[k]!);
    }
  }
  if (run.length !== 0) carry[h] = run;
  return out;
}

/** One level of the canonical scan over a run of nodes (the list end closes the last run). */
function chunkLevel(nodes: CNode[]): CNode[] {
  const out: CNode[] = [];
  let run: CNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i]!;
    run.push(nd);
    if ((run.length >= 2 && nodeBoundary(nd)) || run.length >= MAX_RUN) {
      out.push(consBranch(run));
      run = [];
    }
  }
  if (run.length !== 0) out.push(consBranch(run));
  return out;
}

// Iterators inherit the ES2025 iterator helpers (`map`, `filter`, …) where
// the runtime has them, exactly as the collections' iterators do.
const IteratorBase = ((globalThis as { Iterator?: unknown }).Iterator ?? Object) as new () => object;

/** Leaf-at-a-time iteration on an explicit stack (a generator costs ~3× here). */
class ChunkIterator<T> extends IteratorBase implements IterableIterator<T> {
  readonly #stack: Frame[];
  #items: readonly unknown[] = [];
  #i = 0;
  #tail: readonly unknown[] | null;
  constructor(root: CNode | null, tail: readonly unknown[]) {
    super();
    this.#stack = root === null ? [] : [{ node: root, i: 0 }];
    this.#tail = tail.length === 0 ? null : tail;
  }
  next(): IteratorResult<T> {
    if (this.#i < this.#items.length) return { value: this.#items[this.#i++] as T, done: false };
    const stack = this.#stack;
    while (stack.length !== 0) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.node.kids.length) {
        stack.pop();
        continue;
      }
      if (top.node.ht === 1) {
        this.#items = top.node.kids;
        this.#i = 1;
        stack.pop();
        return { value: this.#items[0] as T, done: false };
      }
      stack.push({ node: top.node.kids[top.i] as CNode, i: 0 });
      top.i++;
    }
    if (this.#tail !== null) {
      this.#items = this.#tail;
      this.#tail = null;
      this.#i = 1;
      return { value: this.#items[0] as T, done: false };
    }
    return { value: undefined, done: true };
  }
  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }
}

const RESYNC_WINDOW = 64;

function sumN(run: CNode[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) n += run[i]!.n;
  return n;
}

function diffRuns(A: CNode[], B: CNode[], ht: number, aPos: number, bPos: number, out: Hunk[]): void {
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      aPos += A[i]!.n;
      bPos += B[j]!.n;
      i++;
      j++;
      continue;
    }
    // Mismatch: find the nearest resync pair (A[i+di] === B[j+dj]) by total distance.
    let di = A.length - i;
    let dj = B.length - j;
    search: for (let d = 1; d <= RESYNC_WINDOW; d++) {
      for (let x = 0; x <= d; x++) {
        const y = d - x;
        if (i + x < A.length && j + y < B.length && A[i + x] === B[j + y]) {
          di = x;
          dj = y;
          break search;
        }
      }
    }
    const aLen = sumN(A, i, i + di);
    const bLen = sumN(B, j, j + dj);
    if (ht === 1) {
      const ia: unknown[] = [];
      for (let x = i; x < i + di; x++) for (const el of A[x]!.kids) ia.push(el);
      const ib: unknown[] = [];
      for (let y = j; y < j + dj; y++) for (const el of B[y]!.kids) ib.push(el);
      let p = 0;
      while (p < ia.length && p < ib.length && same(ia[p], ib[p])) p++;
      let s = 0;
      while (s < ia.length - p && s < ib.length - p && same(ia[ia.length - 1 - s], ib[ib.length - 1 - s])) s++;
      if (ia.length - p - s > 0 || ib.length - p - s > 0) {
        out.push({ aStart: aPos + p, aEnd: aPos + ia.length - s, bStart: bPos + p, bEnd: bPos + ib.length - s });
      }
    } else {
      const ka: CNode[] = [];
      for (let x = i; x < i + di; x++) for (const k of A[x]!.kids) ka.push(k as CNode);
      const kb: CNode[] = [];
      for (let y = j; y < j + dj; y++) for (const k of B[y]!.kids) kb.push(k as CNode);
      diffRuns(ka, kb, ht - 1, aPos, bPos, out);
    }
    aPos += aLen;
    bPos += bLen;
    i += di;
    j += dj;
  }
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}
