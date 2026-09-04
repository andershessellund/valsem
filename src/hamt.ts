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
// Node pools ride the shared incremental sweeper (intern-pool.ts), which was
// sized for exactly this node-registration traffic.
// ---------------------------------------------------------------------------

import { createInternPool, type InternPool } from './intern-pool.js';
import { internHash } from './intern.js';

/** Absent-key sentinel for {@link trieGet} — distinct from a stored `undefined`. */
export const NOT_FOUND: unique symbol = Symbol('valsem.hamt.notFound');

/** Bitmap node: inline entries under `dmap`, child nodes under `nmap`. */
export interface BNode {
  readonly t: 0;
  /** Consed content hash. */
  readonly h: number;
  readonly dmap: number;
  readonly nmap: number;
  /** Entry slots (stride each, in bit order), then child slots (in bit order). */
  readonly slots: readonly unknown[];
}

/** Collision node: entries whose keys share one full 32-bit hash. */
export interface CNode {
  readonly t: 1;
  readonly h: number;
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

// SameValueZero — identity plus NaN-equals-NaN; members and stored values are
// compared this way throughout (matching native Map/Set key semantics).
function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** Ordered hash combine — boost-style. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
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

// ---------------------------------------------------------------------------
// Consing constructors
// ---------------------------------------------------------------------------

function consB(cfg: TrieConfig, dmap: number, nmap: number, slots: unknown[]): BNode {
  let h = mix(0xb17e5, dmap);
  h = mix(h, nmap);
  const dataEnd = popcount(dmap) * cfg.stride;
  for (let i = 0; i < dataEnd; i++) h = mix(h, internHash(slots[i]));
  for (let i = dataEnd; i < slots.length; i++) h = mix(h, (slots[i] as HNode).h);
  const found = cfg.bpool.lookup(
    h,
    (c) => c.dmap === dmap && c.nmap === nmap && slotsSame(c.slots, slots),
  );
  if (found !== undefined) return found;
  return cfg.bpool.register({ t: 0, h, dmap, nmap, slots }, h);
}

function consC(cfg: TrieConfig, khash: number, slots: unknown[]): CNode {
  let h = mix(0xc0111, khash);
  for (let i = 0; i < slots.length; i++) h = mix(h, internHash(slots[i]));
  const found = cfg.cpool.lookup(h, (c) => c.khash === khash && slotsSame(c.slots, slots));
  if (found !== undefined) return found;
  return cfg.cpool.register({ t: 1, h, khash, slots }, h);
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
 * from the sentinel.
 */
export function trieGet(
  cfg: TrieConfig,
  node: HNode,
  khash: number,
  key: unknown,
): unknown {
  const stride = cfg.stride;
  let shift = 0;
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
// Iteration — structure-determined (hence content-determined) order
// ---------------------------------------------------------------------------

/** Yield `[key, value]` pairs (stride 2). */
export function* trieEntries(cfg: TrieConfig, node: HNode): Generator<[unknown, unknown]> {
  const dataEnd = node.t === 0 ? popcount(node.dmap) * 2 : node.slots.length;
  for (let i = 0; i < dataEnd; i += 2) {
    yield [node.slots[i], node.slots[i + 1]];
  }
  if (node.t === 0) {
    for (let i = dataEnd; i < node.slots.length; i++) {
      yield* trieEntries(cfg, node.slots[i] as HNode);
    }
  }
}

/** Yield keys/members (either stride). */
export function* trieKeys(cfg: TrieConfig, node: HNode): Generator<unknown> {
  const stride = cfg.stride;
  const dataEnd = node.t === 0 ? popcount(node.dmap) * stride : node.slots.length;
  for (let i = 0; i < dataEnd; i += stride) {
    yield node.slots[i];
  }
  if (node.t === 0) {
    for (let i = dataEnd; i < node.slots.length; i++) {
      yield* trieKeys(cfg, node.slots[i] as HNode);
    }
  }
}

/** @internal Node-pool sizes — exposed for sharing/canonicality tests. */
export function _trieStats(cfg: TrieConfig): { bnodes: number; cnodes: number } {
  return { bnodes: cfg.bpool.size(), cnodes: cfg.cpool.size() };
}
