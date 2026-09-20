// ---------------------------------------------------------------------------
// intern-pool — weak pools, swept in place by the registrations that use them.
//
// A pool is 64 open-addressed tables (linear probing), sharded by hash and
// created on first use: see SHARDS. A slot is one int32 WORD in an Int32Array
// — 26 bits of the multiplied hash above a 6-bit epoch STAMP — beside the
// WeakRef to the pooled object in a parallel array. The hash is multiplied
// first (Fibonacci hashing, a bijection on 32 bits): its top 6 bits choose the
// shard and the other 26 are the word's tag, so a tag match within a shard IS
// full 32-bit hash equality, and a lookup offers the predicate exactly the
// candidates registered under that hash. Everything the index needs to know
// about an entry without touching it — its hash, its home slot, whether it has
// been seen alive lately — is in that word: a miss (the path of every fresh
// node) reads the Int32Array alone, sixteen slots to a cache line, and so do
// growing the table and skipping an entry known to be alive.
//
// Whether an entry is dead can only be asked (`deref()`), and asking is what
// costs: ~5 ns of a cleared ref, ~40 ns of a live one in a warm cache, several
// times that in a cold one. Two things keep the asking rare:
//
//   * a CANARY — a WeakRef to an object nothing holds — is looked at every 64th
//     registration. Engines clear WeakRefs only when they collect, so until the
//     canary is gone nothing else can have died either. Each time it goes, the
//     EPOCH advances. A word's stamp is the epoch in which its target was last
//     known alive (registered, found, or verified), and an entry stamped with
//     the current epoch is passed over untouched;
//   * a collection is otherwise IGNORED unless a 64-slot sample finds at least
//     two thirds of the pool dead. The sample is taken once per pool per epoch,
//     from whichever shard is registered into first: shards are random
//     partitions of one population, so its answer is every shard's.
//
// When a collection is answered, each shard is swept IN PLACE, a few slots per
// registration into it: the living are restamped, the dead removed by backward
// shift (linear probing's deletion without tombstones — measured, under one
// slot scanned and 0.2 entries moved per removal). Nothing is allocated because
// of a collection. A table is replaced only to grow (or, after a sweep has left
// it under an eighth full, to shrink): incrementally, four entries per
// registration, into a table sized exactly for what it will receive, the old
// one left unwritten so that its probe chains stay valid and a lookup probes
// the current table, then the old. A copy that begins while a sweep is due
// does the verifying itself.
//
// The canary is a hint, not a requirement on the runtime: if it never clears
// there are no sweeps (and nothing was cleared); if it clears often there are
// more of them. A lookup always dereferences what it returns, so no answer
// ever depends on it.
//
// What this replaced, and why (D2, D3): a Map per shard with a
// FinalizationRegistry reporting each death and the bucket surgery deferred to
// idle time; and, between that and this, a version that verified by copying
// each shard into a fresh table. Measured side by side
// (scripts/experiments/mix-bench.mjs). It also asks less of the host: no
// finalization callbacks (which some runtimes run without an I/O context, or
// not at all), no timers, no idle callbacks.
//
// What it costs: cleanup rides on registration. A pool that stops registering
// stops burying its dead — the husks (a cleared WeakRef and a slot of table
// each) stay until registration resumes or the pool is dropped.
//
// Requires WeakRef (ES2021; every supported runtime ships it).
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';

/**
 * The index is SHARDS tables, not one. Replacing a table begins by allocating
 * the next one whole — measured, 1.6 ms for a million slots and 25 ms for eight
 * million — and an engine keeps an array fast only up to a length (V8: 32M
 * elements). With 64 shards the allocation is a 64th of the pool's and the
 * ceiling is two billion. Shards are created on first use: most pools are small.
 */
const SHARD_BITS = 6;
const SHARDS = 1 << SHARD_BITS;

/** The stamp takes the word's low bits — the ones the shard bits vacate when the multiplied hash is shifted up. */
const STAMP_MASK = SHARDS - 1;

/** log2 of a new shard's slots. */
const MIN_BITS = 6;
/** A table is replaced by a larger one when half full… */
const GROW_AT = 0.5;
/** …and by a smaller one when a sweep has left it this empty… */
const SHRINK_BELOW = 1 / 8;
/** …in both cases by one sized to end its copy under this load. */
const TARGET_LOAD = 0.45;
/** A verifying copy is sized on the hope that most of it is dead, but never so that it could end above this load if none is. */
const SAFE_LOAD = 0.8;
/** Occupied slots dereferenced to estimate a pool's survivors. */
const SAMPLE = 64;
/**
 * A collection is answered only when the sample finds at least this fraction
 * dead. It sets the equilibrium: at two thirds the dead number about twice the
 * living at most, a sweep wastes at most one live dereference for every two
 * entries it frees, and (measured on a million live entries under steady churn)
 * operations cost a fifth less than at one half, for more time in collections.
 */
const DEAD_FRACTION = 0.67;
/**
 * What one registration may spend on its shard's sweep or copy. It is paid
 * inside `register`, in the registrations that follow a collection, where a
 * short operation feels it: slots passed (dead and empty ones are cheap)…
 */
const SLOTS_PER_STEP = 16;
/** …living entries dereferenced by a sweep (each a cache miss or two)… */
const LIVE_PER_STEP = 1;
/** …or entries copied to a new table (a verified one counts double). */
const COPIED_PER_STEP = 4;
/** A shard this small is left alone by a collection; it is looked at when it next grows. */
const IGNORE_BELOW = 32;

// ---------------------------------------------------------------------------
// The GC epoch — one for every pool
// ---------------------------------------------------------------------------

let canary = new WeakRef<object>({});
let epoch = 1;
/** The epoch as a stamp: 1…63, never 0, so that a zero word is an empty slot. */
let stamp = 1;
let tick = 0;

/** Every 64th registration: has the canary been collected? Then so may anything else have been. */
function observeCollections(): void {
  if ((++tick & 63) !== 0 || canary.deref() !== undefined) return;
  canary = new WeakRef<object>({});
  epoch++;
  // A stamp that survives 63 epochs unrefreshed reads as current again: one
  // entry is moved once more without being asked, and asked the epoch after.
  stamp = ((epoch - 1) % STAMP_MASK) + 1;
}

// ---------------------------------------------------------------------------
// A shard: the current table, and the old one while it is copied
// ---------------------------------------------------------------------------

class Shard {
  bits = MIN_BITS;
  words = new Int32Array(1 << MIN_BITS);
  refs: (WeakRef<object> | undefined)[] = new Array<WeakRef<object> | undefined>(1 << MIN_BITS).fill(undefined);
  used = 0;

  oldBits = 0;
  oldWords: Int32Array | null = null;
  oldRefs: (WeakRef<object> | undefined)[] = [];
  /** Next slot of the old table to copy; everything below it has been copied or dropped. */
  cursor = 0;
  /** Does this copy dereference (a sweep was due when it began), or just copy? */
  verify = false;

  /** Where the sweep stands, and the slots it has yet to pass; zero when none is due. */
  sweepAt = 0;
  sweepLeft = 0;
  /** The epoch of the last collection this shard has answered, by a sweep or by deciding against one. */
  answered = epoch;
}

/** Store `word` (tag and stamp) and its ref in the current table. The table is never full: see `beginCopy`. */
function place(s: Shard, word: number, ref: WeakRef<object>): void {
  const words = s.words;
  const mask = words.length - 1;
  let i = (word & ~STAMP_MASK) >>> (32 - s.bits);
  while (words[i] !== 0) i = (i + 1) & mask;
  words[i] = word;
  s.refs[i] = ref;
  s.used++;
}

/**
 * Empty slot `i` of the current table, and close the gap: every entry after it,
 * up to the next empty slot, moves back if its home slot allows. Linear
 * probing's deletion without tombstones; it reads the words alone.
 */
function removeAt(s: Shard, i: number): void {
  const words = s.words;
  const refs = s.refs;
  const mask = words.length - 1;
  const shift = 32 - s.bits;
  for (let j = (i + 1) & mask, w = words[j]!; w !== 0; j = (j + 1) & mask, w = words[j]!) {
    const home = (w & ~STAMP_MASK) >>> shift;
    // An entry may move back to i unless its home lies (cyclically) after i, up to where it is now.
    if (i <= j ? i < home && home <= j : i < home || home <= j) continue;
    words[i] = w;
    refs[i] = refs[j];
    i = j;
  }
  words[i] = 0;
  refs[i] = undefined;
  s.used--;
}

/** The fraction of a shard's entries that are alive, from SAMPLE occupied slots at a random place. The shard is not empty: see `register`. */
function sampleSurvivors(s: Shard): number {
  const words = s.words;
  const mask = words.length - 1;
  let live = 0;
  let seen = 0;
  let i = (Math.random() * words.length) | 0;
  for (let passed = 0; seen < SAMPLE && passed <= mask; passed++, i = (i + 1) & mask) {
    const w = words[i]!;
    if (w === 0) continue;
    seen++;
    if ((w & STAMP_MASK) === stamp || s.refs[i]!.deref() !== undefined) live++;
  }
  return live / seen;
}

/** log2 of the smallest table that holds `entries` under `load`. */
function bitsFor(entries: number, load: number): number {
  let bits = MIN_BITS;
  while ((1 << bits) * load < entries) bits++;
  return bits;
}

/**
 * Retire the current table and begin copying it into a fresh one, sized for
 * what that one will receive: what is copied, and the registrations that
 * arrive meanwhile (one per COPIED_PER_STEP entries, or per SLOTS_PER_STEP
 * slots, whichever is more). A verifying copy is begun because most of the
 * table is believed dead, so it keeps the size it has — unless that could not
 * hold everything should the belief be wrong.
 */
function beginCopy(s: Shard, verify: boolean): void {
  const size = s.words.length;
  const arriving = Math.max(s.used / (verify ? COPIED_PER_STEP / 2 : COPIED_PER_STEP), size / SLOTS_PER_STEP) + 16;
  const bits = verify ? Math.max(s.bits, bitsFor(s.used + arriving, SAFE_LOAD)) : bitsFor(s.used + arriving, TARGET_LOAD);
  if (bits === s.bits && !verify) return; // asked to shrink, and it would not
  s.oldBits = s.bits;
  s.oldWords = s.words;
  s.oldRefs = s.refs;
  s.cursor = 0;
  s.verify = verify;
  s.sweepLeft = 0;
  s.sweepAt = 0;
  s.bits = bits;
  s.words = new Int32Array(1 << bits);
  s.refs = new Array<WeakRef<object> | undefined>(1 << bits).fill(undefined);
  s.used = 0;
}

/** One registration's worth of copying. */
function copy(s: Shard): void {
  const oldWords = s.oldWords!;
  const end = oldWords.length;
  let c = s.cursor;
  let entries = COPIED_PER_STEP;
  let slots = SLOTS_PER_STEP;
  while (entries > 0 && slots-- > 0 && c < end) {
    const w = oldWords[c]!;
    if (w !== 0) {
      const ref = s.oldRefs[c]!;
      if (!s.verify || (w & STAMP_MASK) === stamp) {
        place(s, w, ref);
        entries--;
      } else if (ref.deref() !== undefined) {
        place(s, (w & ~STAMP_MASK) | stamp, ref);
        entries -= 2;
      }
      // else: dead, and not copying it is the whole of its burial
    }
    c++;
  }
  s.cursor = c;
  if (c < end) return;
  s.oldWords = null;
  s.oldRefs = [];
  if (s.used < s.words.length * SHRINK_BELOW && s.bits > MIN_BITS) beginCopy(s, false);
}

/** One registration's worth of sweeping the current table in place. */
function sweep(s: Shard): void {
  const words = s.words;
  const mask = words.length - 1;
  let at = s.sweepAt & mask;
  let left = s.sweepLeft;
  let live = LIVE_PER_STEP;
  for (let slots = SLOTS_PER_STEP; slots > 0 && live > 0 && left > 0; slots--) {
    const w = words[at]!;
    if (w !== 0 && (w & STAMP_MASK) !== stamp) {
      if (s.refs[at]!.deref() === undefined) {
        removeAt(s, at);
        continue; // stay: what moved back into this slot has not been looked at
      }
      words[at] = (w & ~STAMP_MASK) | stamp;
      live--;
    }
    at = (at + 1) & mask;
    left--;
  }
  s.sweepAt = at;
  s.sweepLeft = left;
  if (left <= 0 && s.used < words.length * SHRINK_BELOW && s.bits > MIN_BITS) beginCopy(s, false);
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * A typed, weakly-held pool of canonical instances of `T`.
 *
 * Members are retained via `WeakRef` and leave the pool once nothing else
 * references them: a member the garbage collector has taken is swept from
 * the pool's index as registration continues (see the module header). This
 * backs the persistent
 * {@link ValueList}/{@link ValueMap}/{@link ValueSet}/{@link InternedString}
 * collections and any consumer value type (see {@link createInternPool}).
 *
 * The high-level entry point is {@link InternPool.intern}; the lower-level
 * {@link InternPool.lookup}/{@link InternPool.register} pair is for callers that
 * compute the hash and allocate the instance themselves.
 *
 * @typeParam T - The object type of the pooled canonical instances.
 */
export interface InternPool<T extends object> {
  /**
   * Look up an existing canonical instance with the given hash whose
   * structural content matches the predicate. Returns the canonical
   * instance, or `undefined` if no match is found (caller must allocate
   * and {@link register} a fresh instance).
   */
  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined;

  /**
   * Register a freshly-allocated instance with its hash. The instance is
   * weakly retained; once unreferenced elsewhere it will be GC'd and its
   * pool metadata reclaimed.
   */
  register(value: T, hash: number): T;

  /**
   * Intern `object` using its own `[hashCode]` and `[equals]` symbols.
   *
   * On a cache hit the canonical instance is returned and `object` is
   * discarded (no allocation committed). On a miss `object` is frozen,
   * marked `[interned]=true`, registered, and returned as the new
   * canonical instance.
   *
   * The object must have `[hashCode]: number` set before calling this.
   */
  intern(object: T): T;

  /** @internal Live pool size (walks every table) — exposed for tests. */
  size(): number;
}

class InternPoolImpl<T extends object> implements InternPool<T> {
  readonly #shards: (Shard | undefined)[] = new Array<Shard | undefined>(SHARDS).fill(undefined);
  /** The epoch whose collection this pool has sampled, and the fraction it found alive. */
  #sampled = 0;
  #survivors = 1;

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const m = Math.imul(hash, 0x9e3779b1);
    const s = this.#shards[m >>> (32 - SHARD_BITS)];
    if (s === undefined) return undefined;
    const tag = m << SHARD_BITS;

    const words = s.words;
    let mask = words.length - 1;
    let i = tag >>> (32 - s.bits);
    for (let w = words[i]!; w !== 0; i = (i + 1) & mask, w = words[i]!) {
      if ((w & ~STAMP_MASK) !== tag) continue;
      const candidate = s.refs[i]!.deref();
      if (candidate !== undefined && predicate(candidate as T)) {
        if ((w & STAMP_MASK) !== stamp) words[i] = tag | stamp; // seen alive: the next lap need not ask
        return candidate as T;
      }
    }

    const oldWords = s.oldWords;
    if (oldWords === null) return undefined;
    // Below the cursor the living have been moved (and were found above): what a probe meets there is dead.
    mask = oldWords.length - 1;
    i = tag >>> (32 - s.oldBits);
    for (let w = oldWords[i]!; w !== 0; i = (i + 1) & mask, w = oldWords[i]!) {
      if ((w & ~STAMP_MASK) !== tag) continue;
      const candidate = s.oldRefs[i]!.deref();
      if (candidate !== undefined && predicate(candidate as T)) {
        if ((w & STAMP_MASK) !== stamp) oldWords[i] = tag | stamp;
        return candidate as T;
      }
    }
    return undefined;
  }

  register(value: T, hash: number): T {
    observeCollections();
    const m = Math.imul(hash, 0x9e3779b1);
    const s = (this.#shards[m >>> (32 - SHARD_BITS)] ??= new Shard());

    if (s.oldWords !== null) {
      copy(s);
    } else {
      const full = s.used >= s.words.length * GROW_AT;
      if (s.answered !== epoch && (full || s.used > IGNORE_BELOW)) {
        // A shard answers a collection once: until the next one, nothing more can be found dead.
        s.answered = epoch;
        if (this.#sampled !== epoch) {
          this.#sampled = epoch;
          this.#survivors = sampleSurvivors(s);
        }
        if (1 - this.#survivors >= DEAD_FRACTION) s.sweepLeft = s.words.length;
      }
      if (full) beginCopy(s, s.sweepLeft > 0); // growing anyway: the copy does the sweep's work
      else if (s.sweepLeft > 0) sweep(s);
    }
    place(s, (m << SHARD_BITS) | stamp, new WeakRef<object>(value));
    return value;
  }

  intern(object: T): T {
    if ((object as Record<symbol, unknown>)[internedSym] === true) return object;
    const hash = (object as Record<symbol, unknown>)[hashCodeSym] as number;
    const eq = (object as Record<symbol, unknown>)[equalsSym];
    const found = this.lookup(
      hash,
      (c) => typeof eq === 'function' && !!(eq as (other: unknown) => boolean).call(object, c),
    );
    if (found !== undefined) return found;
    (object as Record<symbol, unknown>)[internedSym] = true;
    Object.freeze(object);
    return this.register(object, hash);
  }

  size(): number {
    let n = 0;
    for (const s of this.#shards) {
      if (s === undefined) continue;
      for (let i = 0; i < s.words.length; i++) if (s.words[i] !== 0 && s.refs[i]!.deref() !== undefined) n++;
      if (s.oldWords === null) continue;
      for (let i = s.cursor; i < s.oldWords.length; i++) if (s.oldWords[i] !== 0 && s.oldRefs[i]!.deref() !== undefined) n++;
    }
    return n;
  }

  /** @internal Test-only: entries stored (live, or dead and not yet dropped), the slots of every table, and the shards with a table being copied or a sweep under way. */
  _stats(): { slots: number; capacity: number; migrating: number; sweeping: number } {
    let slots = 0;
    let capacity = 0;
    let migrating = 0;
    let sweeping = 0;
    for (const s of this.#shards) {
      if (s === undefined) continue;
      slots += s.used;
      capacity += s.words.length;
      if (s.sweepLeft > 0) sweeping++;
      if (s.oldWords === null) continue;
      migrating++;
      capacity += s.oldWords.length;
      for (let i = s.cursor; i < s.oldWords.length; i++) if (s.oldWords[i] !== 0) slots++;
    }
    return { slots, capacity, migrating, sweeping };
  }
}

/**
 * Create an empty {@link InternPool} for a value type `T`.
 *
 * Give a class its own pool to make its instances canonical (equal contents ⟹
 * `===`), the same way the built-in collections are. The pool holds its members
 * weakly, so canonical instances are reclaimed by GC once unreferenced. Because
 * a pool only ever holds one type, its hashes need no type tag to avoid
 * cross-type collisions.
 *
 * @typeParam T - The object type of the pooled canonical instances.
 * @returns A fresh, empty pool.
 *
 * @example
 * ```ts
 * const pool = createInternPool<Point>();
 *
 * class Point {
 *   declare readonly [hashCode]: number;
 *   declare readonly [interned]: true;
 *   private constructor(readonly x: number, readonly y: number) {}
 *   [equals](o: unknown) { return o instanceof Point && o.x === this.x && o.y === this.y; }
 *   static of(x: number, y: number): Point {
 *     const p = new Point(x, y);
 *     (p as any)[hashCode] = (x * 73856093) ^ (y * 19349663);
 *     return pool.intern(p); // frozen, marked interned, deduplicated
 *   }
 * }
 * ```
 */
export function createInternPool<T extends object>(): InternPool<T> {
  return new InternPoolImpl<T>();
}

// ---------------------------------------------------------------------------
// Test-only inspection hooks (not exported from the package barrel)
// ---------------------------------------------------------------------------

/** @internal Test-only: entries a pool stores (live, or dead and not yet dropped), the slots of all its tables, and how many shards have a table being copied, or a sweep under way. */
export function _poolStats(pool: InternPool<object>): { slots: number; capacity: number; migrating: number; sweeping: number } {
  return (pool as InternPoolImpl<object>)._stats();
}

/** @internal Test-only: the GC epoch — how many times the canary has been seen gone, plus one. */
export function _epoch(): number {
  return epoch;
}
