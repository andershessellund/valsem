// ---------------------------------------------------------------------------
// hamt — hash-consed CHAMP trie core, shared by ValueMap (stride 2, key+value
// slots per entry) and ValueSet (stride 1).
//
// Two layers of one idea:
//
// * **The trie** addresses an entry by its key hash, five bits per level
//   (32-way branching, ≤7 levels, full-hash collisions in collision nodes at
//   the bottom). A node carries two bitmaps — `dmap` marks inline entries,
//   `nmap` marks child nodes — and a dense slot array indexed by popcount.
//   Updates path-copy the ≤7 touched nodes and share everything else.
//
// * **Hash consing** routes every node allocation through an intern pool:
//   before a node is created, an existing node with the same bitmaps and
//   pairwise-identical slots is returned instead. Children are consed before
//   parents, so a shallow slot comparison is a deep structural one by
//   induction — and two tries with equal content are **the same root
//   object**. Deep equality of whole collections is `===` on roots.
//
// Consing is sound only because the tree shape is a pure function of the
// content (history-independence):
//   - insertion order cannot matter (the shape is hash-directed);
//   - deletion restores exactly the shape insertion would build — a subtree
//     collapsing to a single entry is inlined upward, unwinding prefix
//     chains (the CHAMP canonical-form invariant: a non-root node never has
//     arity < 2);
//   - collision-node entries keep a canonical order (primitives by type and
//     value; objects by a lazily-assigned per-instance ordinal — sound
//     within a process because members are compared by identity, so equal
//     content means the same instances).
//
// Node pools are ordinary intern pools (intern-pool.ts): every consed node is
// a weakly-held pool member, reclaimed in idle time once unreferenced.
// ---------------------------------------------------------------------------

import { createInternPool, type InternPool } from './intern-pool.js';
import { internHash } from './intern.js';
import { mix } from './hasher.js';
import { same, sameSlots, IteratorBase } from './shared.js';

/** Absent-key sentinel for {@link trieGet} — distinct from a stored `undefined`. */
export const NOT_FOUND: unique symbol = Symbol('valsem.hamt.notFound');

/** Bitmap node: inline entries under `dmap`, child nodes under `nmap`. */
export interface BNode {
  readonly t: 0;
  /** Consed content hash. */
  readonly h: number;
  /** Entries in this subtree — a function of the content, so consed with it. */
  readonly n: number;
  readonly dmap: number;
  readonly nmap: number;
  /** Entry slots (stride each, in bit order), then child slots (in bit order). */
  readonly slots: readonly unknown[];
}

/** Collision node: entries whose keys share one full 32-bit hash. */
export interface CNode {
  readonly t: 1;
  readonly h: number;
  /** Entries in this node. */
  readonly n: number;
  readonly khash: number;
  /** Entry slots (stride each), in canonical member order. */
  readonly slots: readonly unknown[];
}

export type HNode = BNode | CNode;

export interface TrieConfig {
  readonly stride: 1 | 2;
  readonly bpool: InternPool<BNode>;
  readonly cpool: InternPool<CNode>;
  readonly empty: BNode;
}

// Members and stored values compare by SameValueZero (`same`) throughout.

function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

// ---------------------------------------------------------------------------
// Consing constructors
// ---------------------------------------------------------------------------

function consB(cfg: TrieConfig, dmap: number, nmap: number, slots: unknown[]): BNode {
  let h = mix(0xb17e5, dmap);
  h = mix(h, nmap);
  const dataEnd = popcount(dmap) * cfg.stride;
  for (let i = 0; i < dataEnd; i++) h = mix(h, internHash(slots[i]));
  let n = popcount(dmap);
  for (let i = dataEnd; i < slots.length; i++) {
    const child = slots[i] as HNode;
    h = mix(h, child.h);
    n += child.n;
  }
  const found = cfg.bpool.lookup(
    h,
    (c) => c.dmap === dmap && c.nmap === nmap && sameSlots(c.slots, slots),
  );
  if (found !== undefined) return found;
  return cfg.bpool.register({ t: 0, h, n, dmap, nmap, slots }, h);
}

function consC(cfg: TrieConfig, khash: number, slots: unknown[]): CNode {
  let h = mix(0xc0111, khash);
  for (let i = 0; i < slots.length; i++) h = mix(h, internHash(slots[i]));
  const found = cfg.cpool.lookup(h, (c) => c.khash === khash && sameSlots(c.slots, slots));
  if (found !== undefined) return found;
  return cfg.cpool.register({ t: 1, h, n: slots.length / cfg.stride, khash, slots }, h);
}

export function createTrieConfig(stride: 1 | 2): TrieConfig {
  const cfg: {
    stride: 1 | 2;
    bpool: InternPool<BNode>;
    cpool: InternPool<CNode>;
    empty: BNode;
  } = {
    stride,
    bpool: createInternPool<BNode>(),
    cpool: createInternPool<CNode>(),
    empty: undefined as unknown as BNode,
  };
  cfg.empty = consB(cfg, 0, 0, []);
  return cfg;
}

// ---------------------------------------------------------------------------
// Canonical member order for collision nodes
// ---------------------------------------------------------------------------

const ordinals = new WeakMap<object, number>();
let nextOrdinal = 1;

function ordinal(o: object): number {
  let n = ordinals.get(o);
  if (n === undefined) {
    n = nextOrdinal++;
    ordinals.set(o, n);
  }
  return n;
}

function typeRank(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  switch (typeof v) {
    case 'boolean':
      return 2;
    case 'number':
      return 3;
    case 'bigint':
      return 4;
    case 'string':
      return 5;
    default:
      return 6; // objects (the only other hashable kind)
  }
}

/**
 * Deterministic total order over distinct members sharing a full hash. Only
 * ever consulted inside collision nodes. Object order uses per-instance
 * ordinals — sound because membership is by identity, so equal content means
 * the same instances, which get the same ordinals process-wide.
 */
function memberCompare(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 2:
      return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    case 3: {
      const na = a as number;
      const nb = b as number;
      if (na !== na) return nb !== nb ? 0 : 1; // NaN sorts last among numbers
      if (nb !== nb) return -1;
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    case 4:
      return (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0;
    case 5:
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case 6:
      return ordinal(a as object) - ordinal(b as object);
    default:
      return 0; // undefined/null are singletons — never two distinct
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * The value stored under `key` (for stride 1, the stored member itself), or
 * {@link NOT_FOUND}. A stored `undefined` comes back as `undefined`, distinct
 * from the sentinel. `shift` is the level of `node` — 0 for a root.
 */
export function trieGet(
  cfg: TrieConfig,
  node: HNode,
  khash: number,
  key: unknown,
  shift = 0,
): unknown {
  const stride = cfg.stride;
  let n = node;
  while (n.t === 0) {
    const bit = 1 << ((khash >>> shift) & 31);
    if (n.dmap & bit) {
      const i = popcount(n.dmap & (bit - 1)) * stride;
      if (!same(n.slots[i], key)) return NOT_FOUND;
      return n.slots[i + stride - 1];
    }
    if (!(n.nmap & bit)) return NOT_FOUND;
    const dataEnd = popcount(n.dmap) * stride;
    n = n.slots[dataEnd + popcount(n.nmap & (bit - 1))] as HNode;
    shift += 5;
  }
  if (n.khash !== khash) return NOT_FOUND;
  for (let i = 0; i < n.slots.length; i += stride) {
    if (same(n.slots[i], key)) return n.slots[i + stride - 1];
  }
  return NOT_FOUND;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface InsertResult {
  node: HNode;
  /** True when the key was absent (size grows by one). */
  added: boolean;
}

/** Two entries whose keys differ, pushed below `shift`. */
function mergeTwo(
  cfg: TrieConfig,
  shift: number,
  h1: number,
  s1: unknown[],
  h2: number,
  s2: unknown[],
): HNode {
  if (shift >= 32) {
    const ordered =
      memberCompare(s1[0], s2[0]) <= 0 ? [...s1, ...s2] : [...s2, ...s1];
    return consC(cfg, h1, ordered);
  }
  const c1 = (h1 >>> shift) & 31;
  const c2 = (h2 >>> shift) & 31;
  if (c1 === c2) {
    const child = mergeTwo(cfg, shift + 5, h1, s1, h2, s2);
    return consB(cfg, 0, 1 << c1, [child]);
  }
  const slots = c1 < c2 ? [...s1, ...s2] : [...s2, ...s1];
  return consB(cfg, (1 << c1) | (1 << c2), 0, slots);
}

/**
 * Insert (or update) `key` → the last element of `entry`. `entry` is the full
 * slot group: `[key]` for stride 1, `[key, value]` for stride 2. Returns
 * `null` when the trie already holds this exact entry (SameValueZero on the
 * stored value).
 */
export function trieInsert(
  cfg: TrieConfig,
  node: HNode,
  shift: number,
  khash: number,
  entry: unknown[],
): InsertResult | null {
  const stride = cfg.stride;
  const key = entry[0];

  if (node.t === 1) {
    // Collision node — keys here share a full hash; ours must too (the trie
    // only routes us here when the path is exhausted, hence hashes agree).
    for (let i = 0; i < node.slots.length; i += stride) {
      if (same(node.slots[i], key)) {
        if (same(node.slots[i + stride - 1], entry[stride - 1])) return null;
        const slots = node.slots.slice();
        slots[i + stride - 1] = entry[stride - 1];
        return { node: consC(cfg, node.khash, slots), added: false };
      }
    }
    // New member — splice at its canonical position.
    let at = node.slots.length;
    for (let i = 0; i < node.slots.length; i += stride) {
      if (memberCompare(key, node.slots[i]) < 0) {
        at = i;
        break;
      }
    }
    const slots = node.slots.slice();
    slots.splice(at, 0, ...entry);
    return { node: consC(cfg, node.khash, slots), added: true };
  }

  const bit = 1 << ((khash >>> shift) & 31);
  const dataEnd = popcount(node.dmap) * stride;

  if (node.dmap & bit) {
    const i = popcount(node.dmap & (bit - 1)) * stride;
    const existingKey = node.slots[i];
    if (same(existingKey, key)) {
      if (same(node.slots[i + stride - 1], entry[stride - 1])) return null;
      const slots = node.slots.slice();
      slots[i + stride - 1] = entry[stride - 1];
      return { node: consB(cfg, node.dmap, node.nmap, slots), added: false };
    }
    // Two distinct keys claim one position: push both down a level.
    const existing = node.slots.slice(i, i + stride);
    const child = mergeTwo(cfg, shift + 5, internHash(existingKey), existing, khash, entry);
    const slots = node.slots.slice();
    slots.splice(i, stride); // drop the inline entry …
    // … after which children start at dataEnd - stride; insert the new child
    // at its bit position among them.
    slots.splice(dataEnd - stride + popcount(node.nmap & (bit - 1)), 0, child);
    return {
      node: consB(cfg, node.dmap & ~bit, node.nmap | bit, slots),
      added: true,
    };
  }

  if (node.nmap & bit) {
    const ni = dataEnd + popcount(node.nmap & (bit - 1));
    const child = node.slots[ni] as HNode;
    const r = trieInsert(cfg, child, shift + 5, khash, entry);
    if (r === null) return null;
    const slots = node.slots.slice();
    slots[ni] = r.node;
    return { node: consB(cfg, node.dmap, node.nmap, slots), added: r.added };
  }

  const at = popcount(node.dmap & (bit - 1)) * stride;
  const slots = node.slots.slice();
  slots.splice(at, 0, ...entry);
  return { node: consB(cfg, node.dmap | bit, node.nmap, slots), added: true };
}

// ---------------------------------------------------------------------------
// Bulk build — the trie for a whole entry list, every node consed once
// ---------------------------------------------------------------------------

/**
 * The canonical trie holding `keys` (with `vals`, for stride 2; `null` for
 * stride 1), built bottom-up: entries are partitioned by hash bits level by
 * level and every node of the result is consed exactly once, where n
 * sequential inserts would path-copy and re-cons O(log n) nodes each. Keys
 * are canonical (so `-0` never arrives: `intern` stores zero as `+0`); a key
 * given twice keeps its last value, as sequential insertion would. The result
 * is the trie that insertion would build — the same root object.
 */
export function trieFrom(cfg: TrieConfig, keys: unknown[], vals: unknown[] | null): HNode {
  // Dedupe (last write wins) on SameValueZero — the native Map's key rule.
  // Keys are canonical, so identity is value equality, and the seen-map
  // costs a hash-table probe per entry, not a trie walk.
  const ks: unknown[] = [];
  const vs: unknown[] | null = vals === null ? null : [];
  const hs: number[] = [];
  const seen = new Map<unknown, number>();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const at = seen.get(k);
    if (at === undefined) {
      seen.set(k, ks.length);
      ks.push(k);
      hs.push(internHash(k));
      if (vs !== null) vs.push(vals![i]);
    } else if (vs !== null) {
      vs[at] = vals![i];
    }
  }
  if (ks.length === 0) return cfg.empty;
  if (ks.length === 1) {
    return consB(cfg, 1 << (hs[0]! & 31), 0, vs === null ? [ks[0]] : [ks[0], vs[0]]);
  }
  const ids = new Array<number>(ks.length);
  for (let i = 0; i < ids.length; i++) ids[i] = i;
  return buildNode(cfg, ks, vs, hs, ids, 0);
}

/**
 * The node for the ≥ 2 distinct entries `ids` (indices into `ks`/`vs`/`hs`)
 * below `shift`. Distinct keys either separate at some level or share the
 * full hash, so the result is always a node, never a lone entry — which is
 * what lets a one-entry bucket be inlined as data by the caller (the CHAMP
 * canonical form insertion produces).
 */
function buildNode(
  cfg: TrieConfig,
  ks: unknown[],
  vs: unknown[] | null,
  hs: number[],
  ids: number[],
  shift: number,
): HNode {
  if (shift >= 32) {
    // Every key here shares the full hash: one collision node, in canonical member order.
    ids.sort((a, b) => memberCompare(ks[a], ks[b]));
    const slots: unknown[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      slots.push(ks[id]);
      if (vs !== null) slots.push(vs[id]);
    }
    return consC(cfg, hs[ids[0]!]!, slots);
  }
  // Partition by the five bits at `shift`, in bit order.
  const buckets: (number[] | undefined)[] = new Array(32);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const b = (hs[id]! >>> shift) & 31;
    const g = buckets[b];
    if (g === undefined) buckets[b] = [id];
    else g.push(id);
  }
  let dmap = 0;
  let nmap = 0;
  const data: unknown[] = [];
  const kids: HNode[] = [];
  for (let b = 0; b < 32; b++) {
    const g = buckets[b];
    if (g === undefined) continue;
    if (g.length === 1) {
      dmap |= 1 << b;
      data.push(ks[g[0]!]);
      if (vs !== null) data.push(vs[g[0]!]);
    } else {
      nmap |= 1 << b;
      kids.push(buildNode(cfg, ks, vs, hs, g, shift + 5));
    }
  }
  return consB(cfg, dmap, nmap, kids.length === 0 ? data : data.concat(kids));
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type RemoveResult =
  | { node: HNode; entry: null }
  /** The subtree collapsed to one entry — the parent inlines it (canonical form). */
  | { node: null; entry: unknown[] };

/** Remove `key`. Returns `null` when absent. At `shift` 0 always yields a node. */
export function trieRemove(
  cfg: TrieConfig,
  node: HNode,
  shift: number,
  khash: number,
  key: unknown,
): RemoveResult | null {
  const stride = cfg.stride;

  if (node.t === 1) {
    for (let i = 0; i < node.slots.length; i += stride) {
      if (same(node.slots[i], key)) {
        const slots = node.slots.slice();
        slots.splice(i, stride);
        if (slots.length === stride) return { node: null, entry: slots };
        return { node: consC(cfg, node.khash, slots), entry: null };
      }
    }
    return null;
  }

  const bit = 1 << ((khash >>> shift) & 31);
  const dataEnd = popcount(node.dmap) * stride;

  if (node.dmap & bit) {
    const i = popcount(node.dmap & (bit - 1)) * stride;
    if (!same(node.slots[i], key)) return null;
    const dcount = popcount(node.dmap) - 1;
    const ncount = popcount(node.nmap);
    if (shift > 0 && dcount === 1 && ncount === 0) {
      // Non-root node collapses to its one remaining entry.
      const other = i === 0 ? node.slots.slice(stride, 2 * stride) : node.slots.slice(0, stride);
      return { node: null, entry: other as unknown[] };
    }
    const slots = node.slots.slice();
    slots.splice(i, stride);
    if (shift === 0 && dcount === 0 && ncount === 0) {
      return { node: cfg.empty, entry: null };
    }
    return { node: consB(cfg, node.dmap & ~bit, node.nmap, slots), entry: null };
  }

  if (node.nmap & bit) {
    const ni = dataEnd + popcount(node.nmap & (bit - 1));
    const child = node.slots[ni] as HNode;
    const r = trieRemove(cfg, child, shift + 5, khash, key);
    if (r === null) return null;
    if (r.entry !== null) {
      // Child collapsed to one entry. If this node held ONLY that child, the
      // entry keeps cascading up without materializing this level at all —
      // exactly unwinding the prefix chain insertion would have built.
      if (shift > 0 && node.dmap === 0 && popcount(node.nmap) === 1) {
        return r;
      }
      const slots = node.slots.slice();
      slots.splice(ni, 1); // drop the child …
      const at = popcount(node.dmap & (bit - 1)) * stride;
      slots.splice(at, 0, ...r.entry); // … and inline the entry
      return { node: consB(cfg, node.dmap | bit, node.nmap & ~bit, slots), entry: null };
    }
    const slots = node.slots.slice();
    slots[ni] = r.node;
    return { node: consB(cfg, node.dmap, node.nmap, slots), entry: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Iteration — structure-determined (hence content-determined) order: a
// node's inline entries first, then its children in bit order.
//
// Explicit-stack iterator objects, not generators. A recursive generator
// with `yield*` per level costs O(depth) generator resumptions per element
// (measured ~47 ns/element on V8 for a 10k trie); one `next()` over a
// small stack costs ~10 ns, and a direct callback walk ~6 ns. The classes
// extend the global `Iterator` where it exists, so the iterator helpers
// (`.map`, `.filter`, `.take`, …) work exactly as they did on generators.
// ---------------------------------------------------------------------------

/** Explicit-stack traversal shared by the three iterators: `next()` yields slot indices. */
abstract class TrieIterator<T> extends IteratorBase implements IterableIterator<T> {
  readonly #stride: 1 | 2;
  readonly #nodes: HNode[] = [];
  readonly #idx: number[] = [];
  #depth = -1;

  constructor(stride: 1 | 2, root: HNode) {
    super();
    this.#stride = stride;
    if (root.slots.length > 0) {
      this.#nodes.push(root);
      this.#idx.push(0);
      this.#depth = 0;
    }
  }

  /** The value to emit for the entry starting at `slots[i]`. */
  protected abstract emit(slots: readonly unknown[], i: number): T;

  next(): IteratorResult<T> {
    const stride = this.#stride;
    for (;;) {
      const depth = this.#depth;
      if (depth < 0) return { value: undefined, done: true };
      const node = this.#nodes[depth]!;
      const slots = node.slots;
      const i = this.#idx[depth]!;
      if (i >= slots.length) {
        this.#depth = depth - 1; // this node is exhausted; resume its parent
        continue;
      }
      const dataEnd = node.t === 0 ? popcount(node.dmap) * stride : slots.length;
      if (i < dataEnd) {
        this.#idx[depth] = i + stride;
        return { value: this.emit(slots, i), done: false };
      }
      // A child: descend (the parent's index already points past it).
      this.#idx[depth] = i + 1;
      this.#nodes[depth + 1] = slots[i] as HNode;
      this.#idx[depth + 1] = 0;
      this.#depth = depth + 1;
    }
  }

  [Symbol.iterator](): this {
    return this;
  }
}

class KeyIterator extends TrieIterator<unknown> {
  protected emit(slots: readonly unknown[], i: number): unknown {
    return slots[i];
  }
}

class ValueIterator extends TrieIterator<unknown> {
  protected emit(slots: readonly unknown[], i: number): unknown {
    return slots[i + 1];
  }
}

class EntryIterator extends TrieIterator<[unknown, unknown]> {
  protected emit(slots: readonly unknown[], i: number): [unknown, unknown] {
    return [slots[i], slots[i + 1]];
  }
}

/** `[member, member]` pairs (stride 1) — what `ReadonlySet.entries` yields. */
class PairIterator extends TrieIterator<[unknown, unknown]> {
  protected emit(slots: readonly unknown[], i: number): [unknown, unknown] {
    const v = slots[i];
    return [v, v];
  }
}

/** Iterate keys/members (either stride). */
export function trieKeys(cfg: TrieConfig, node: HNode): IterableIterator<unknown> {
  return new KeyIterator(cfg.stride, node);
}

/** Iterate values of a stride-2 trie — no `[key, value]` tuple allocated. */
export function trieValues(node: HNode): IterableIterator<unknown> {
  return new ValueIterator(2, node);
}

/** Iterate `[key, value]` pairs of a stride-2 trie. */
export function trieEntries(node: HNode): IterableIterator<[unknown, unknown]> {
  return new EntryIterator(2, node);
}

/** Iterate `[member, member]` pairs of a stride-1 trie. */
export function triePairs(node: HNode): IterableIterator<[unknown, unknown]> {
  return new PairIterator(1, node);
}

/**
 * Visit every entry with a callback, in iteration order — the fastest walk
 * (no iterator protocol, no tuples). `fn` receives the slot array and the
 * entry's starting index; for stride 2 the value is at `i + 1`.
 */
export function trieForEach(
  cfg: TrieConfig,
  node: HNode,
  fn: (slots: readonly unknown[], i: number) => void,
): void {
  const stride = cfg.stride;
  const slots = node.slots;
  const dataEnd = node.t === 0 ? popcount(node.dmap) * stride : slots.length;
  for (let i = 0; i < dataEnd; i += stride) fn(slots, i);
  for (let i = dataEnd; i < slots.length; i++) trieForEach(cfg, slots[i] as HNode, fn);
}

/** @internal Node-pool sizes — exposed for sharing/canonicality tests. */
export function _trieStats(cfg: TrieConfig): { bnodes: number; cnodes: number } {
  return { bnodes: cfg.bpool.size(), cnodes: cfg.cpool.size() };
}

// ---------------------------------------------------------------------------
// Set algebra — node-level, stride 1.
//
// Two tries with the same content are the same object, so a merge decides
// subtree equality by pointer and shares every subtree that is present on
// one side only. A position holds a PART: nothing, one member (the collapsed
// form of a one-entry subtree), or a node. The walk combines the two sides'
// parts bit by bit, recursing only where both sides have a node, and conses
// only the nodes it had to rebuild — so the cost is proportional to the
// region where the operands differ, O(1) when they are the same set, and at
// worst linear in the operands (never a per-member insert).
//
// Results are normalised to canonical form at every level — a non-root
// subtree of one member is inlined as data, an empty one disappears — so the
// output is exactly the trie `from` would build for the same content, and
// `===` to it.
// ---------------------------------------------------------------------------

/** One member at a position — the collapsed form of a one-entry subtree. */
class Single {
  constructor(readonly m: unknown) {}
}

type Part = HNode | Single | null;

function partAt(node: BNode, bit: number): Part {
  if (node.dmap & bit) return new Single(node.slots[popcount(node.dmap & (bit - 1))]);
  if (node.nmap & bit) {
    return node.slots[popcount(node.dmap) + popcount(node.nmap & (bit - 1))] as HNode;
  }
  return null;
}

function sizeOf(p: Part): number {
  return p === null ? 0 : p instanceof Single ? 1 : p.n;
}

function contains(cfg: TrieConfig, node: HNode, shift: number, m: unknown): boolean {
  return trieGet(cfg, node, internHash(m), m, shift) !== NOT_FOUND;
}

function insertInto(cfg: TrieConfig, node: HNode, shift: number, m: unknown): HNode {
  const r = trieInsert(cfg, node, shift, internHash(m), [m]);
  return r === null ? node : r.node;
}

function removeFrom(cfg: TrieConfig, node: HNode, shift: number, m: unknown): Part {
  const r = trieRemove(cfg, node, shift, internHash(m), m);
  if (r === null) return node;
  if (r.entry !== null) return new Single(r.entry[0]);
  return r.node;
}

/** Collects a level's parts in bit order and conses the node, normalised for `shift`. */
class Builder {
  dmap = 0;
  nmap = 0;
  readonly data: unknown[] = [];
  readonly kids: HNode[] = [];

  put(bit: number, p: Part): void {
    if (p === null) return;
    if (p instanceof Single) {
      this.dmap |= bit;
      this.data.push(p.m);
    } else {
      this.nmap |= bit;
      this.kids.push(p);
    }
  }

  finish(cfg: TrieConfig, shift: number): Part {
    if (shift > 0) {
      // A child returned by the recursion holds ≥ 2 entries, so a subtree of
      // one entry is exactly one data slot and no children: inline it.
      if (this.kids.length === 0) {
        if (this.data.length === 0) return null;
        if (this.data.length === 1) return new Single(this.data[0]);
      }
    }
    return consB(cfg, this.dmap, this.nmap, (this.data as unknown[]).concat(this.kids));
  }
}

type SetOp = 0 | 1 | 2 | 3; // union | intersection | difference | symmetric difference

/**
 * Two collision nodes at one position share the full hash; their slots are
 * in canonical member order, so every operation is a linear merge.
 */
function mergeCollision(cfg: TrieConfig, a: CNode, b: CNode, op: SetOp): Part {
  const A = a.slots;
  const B = b.slots;
  const out: unknown[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    const c = i >= A.length ? 1 : j >= B.length ? -1 : memberCompare(A[i], B[j]);
    if (c === 0) {
      if (op === 0 || op === 1) out.push(A[i]);
      i++;
      j++;
    } else if (c < 0) {
      if (op !== 1) out.push(A[i]);
      i++;
    } else {
      if (op === 0 || op === 3) out.push(B[j]);
      j++;
    }
  }
  if (out.length === 0) return null;
  if (out.length === 1) return new Single(out[0]);
  return consC(cfg, a.khash, out);
}

function unionParts(cfg: TrieConfig, x: Part, y: Part, shift: number): Part {
  if (x === null) return y;
  if (y === null || x === y) return x;
  if (x instanceof Single) {
    if (y instanceof Single) {
      if (same(x.m, y.m)) return x;
      return mergeTwo(cfg, shift, internHash(x.m), [x.m], internHash(y.m), [y.m]);
    }
    return insertInto(cfg, y, shift, x.m);
  }
  if (y instanceof Single) return insertInto(cfg, x, shift, y.m);
  if (x.t === 1) return mergeCollision(cfg, x, y as CNode, 0);
  const yb = y as BNode;
  const b = new Builder();
  for (let rest = x.dmap | x.nmap | yb.dmap | yb.nmap; rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    b.put(bit, unionParts(cfg, partAt(x, bit), partAt(yb, bit), shift + 5));
  }
  return b.finish(cfg, shift);
}

function intersectParts(cfg: TrieConfig, x: Part, y: Part, shift: number): Part {
  if (x === null || y === null) return null;
  if (x === y) return x;
  if (x instanceof Single) {
    const present = y instanceof Single ? same(x.m, y.m) : contains(cfg, y, shift, x.m);
    return present ? x : null;
  }
  if (y instanceof Single) return contains(cfg, x, shift, y.m) ? y : null;
  if (x.t === 1) return mergeCollision(cfg, x, y as CNode, 1);
  const yb = y as BNode;
  const b = new Builder();
  for (let rest = (x.dmap | x.nmap) & (yb.dmap | yb.nmap); rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    b.put(bit, intersectParts(cfg, partAt(x, bit), partAt(yb, bit), shift + 5));
  }
  return b.finish(cfg, shift);
}

function differenceParts(cfg: TrieConfig, x: Part, y: Part, shift: number): Part {
  if (x === null || x === y) return null;
  if (y === null) return x;
  if (x instanceof Single) {
    const present = y instanceof Single ? same(x.m, y.m) : contains(cfg, y, shift, x.m);
    return present ? null : x;
  }
  if (y instanceof Single) return removeFrom(cfg, x, shift, y.m);
  if (x.t === 1) return mergeCollision(cfg, x, y as CNode, 2);
  const yb = y as BNode;
  const ymask = yb.dmap | yb.nmap;
  const b = new Builder();
  for (let rest = x.dmap | x.nmap; rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    const px = partAt(x, bit);
    b.put(bit, ymask & bit ? differenceParts(cfg, px, partAt(yb, bit), shift + 5) : px);
  }
  return b.finish(cfg, shift);
}

function symmetricParts(cfg: TrieConfig, x: Part, y: Part, shift: number): Part {
  if (x === null) return y;
  if (y === null) return x;
  if (x === y) return null;
  if (x instanceof Single) {
    if (y instanceof Single) {
      if (same(x.m, y.m)) return null;
      return mergeTwo(cfg, shift, internHash(x.m), [x.m], internHash(y.m), [y.m]);
    }
    return contains(cfg, y, shift, x.m) ? removeFrom(cfg, y, shift, x.m) : insertInto(cfg, y, shift, x.m);
  }
  if (y instanceof Single) {
    return contains(cfg, x, shift, y.m) ? removeFrom(cfg, x, shift, y.m) : insertInto(cfg, x, shift, y.m);
  }
  if (x.t === 1) return mergeCollision(cfg, x, y as CNode, 3);
  const yb = y as BNode;
  const b = new Builder();
  for (let rest = x.dmap | x.nmap | yb.dmap | yb.nmap; rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    b.put(bit, symmetricParts(cfg, partAt(x, bit), partAt(yb, bit), shift + 5));
  }
  return b.finish(cfg, shift);
}

function subsetParts(cfg: TrieConfig, x: Part, y: Part, shift: number): boolean {
  if (x === null || x === y) return true;
  if (y === null || sizeOf(x) > sizeOf(y)) return false;
  if (x instanceof Single) return y instanceof Single ? same(x.m, y.m) : contains(cfg, y, shift, x.m);
  if (y instanceof Single) return false; // a node holds ≥ 2 entries
  if (x.t === 1) return sizeOf(mergeCollision(cfg, x, y as CNode, 1)) === x.n;
  const yb = y as BNode;
  const xmask = x.dmap | x.nmap;
  if (xmask & ~(yb.dmap | yb.nmap)) return false;
  for (let rest = xmask; rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    if (!subsetParts(cfg, partAt(x, bit), partAt(yb, bit), shift + 5)) return false;
  }
  return true;
}

function disjointParts(cfg: TrieConfig, x: Part, y: Part, shift: number): boolean {
  if (x === null || y === null) return true;
  if (x === y) return sizeOf(x) === 0;
  if (x instanceof Single) return !(y instanceof Single ? same(x.m, y.m) : contains(cfg, y, shift, x.m));
  if (y instanceof Single) return !contains(cfg, x, shift, y.m);
  if (x.t === 1) return mergeCollision(cfg, x, y as CNode, 1) === null;
  const yb = y as BNode;
  for (let rest = (x.dmap | x.nmap) & (yb.dmap | yb.nmap); rest !== 0; ) {
    const bit = rest & -rest;
    rest ^= bit;
    if (!disjointParts(cfg, partAt(x, bit), partAt(yb, bit), shift + 5)) return false;
  }
  return true;
}

function setRoot(cfg: TrieConfig, p: Part): HNode {
  if (p === null) return cfg.empty;
  if (p instanceof Single) return consB(cfg, 1 << (internHash(p.m) & 31), 0, [p.m]);
  return p;
}

function assertSet(cfg: TrieConfig): void {
  if (cfg.stride !== 1) throw new Error('valsem: node-level set algebra is for stride-1 tries');
}

/** The canonical trie holding the members of `a` or `b` (roots, stride 1). */
export function trieUnion(cfg: TrieConfig, a: HNode, b: HNode): HNode {
  assertSet(cfg);
  return setRoot(cfg, unionParts(cfg, a, b, 0));
}

/** The canonical trie holding the members of both `a` and `b`. */
export function trieIntersection(cfg: TrieConfig, a: HNode, b: HNode): HNode {
  assertSet(cfg);
  return setRoot(cfg, intersectParts(cfg, a, b, 0));
}

/** The canonical trie holding the members of `a` that are not in `b`. */
export function trieDifference(cfg: TrieConfig, a: HNode, b: HNode): HNode {
  assertSet(cfg);
  return setRoot(cfg, differenceParts(cfg, a, b, 0));
}

/** The canonical trie holding the members of exactly one of `a` and `b`. */
export function trieSymmetricDifference(cfg: TrieConfig, a: HNode, b: HNode): HNode {
  assertSet(cfg);
  return setRoot(cfg, symmetricParts(cfg, a, b, 0));
}

/** Whether every member of `a` is in `b`. */
export function trieIsSubset(cfg: TrieConfig, a: HNode, b: HNode): boolean {
  assertSet(cfg);
  return subsetParts(cfg, a, b, 0);
}

/** Whether `a` and `b` share no member. */
export function trieIsDisjoint(cfg: TrieConfig, a: HNode, b: HNode): boolean {
  assertSet(cfg);
  return disjointParts(cfg, a, b, 0);
}
