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
// times that in a cold one. It also PINS: a dereferenced (or freshly made)
// WeakRef keeps its target alive until the job ends, and through the marking
// cycle of an incremental collector. So the pool never watches an object whose
// death it is waiting for — a canary that is looked at never dies — it watches
// its own entries, of which it does not care:
//
//   * every 32nd registration PROBES one entry, whatever its stamp says. A
//     word's stamp is the pool's epoch when its target was last known alive
//     (registered, found, or probed). A probe that finds an entry dead while it
//     carries the CURRENT stamp has proof that a collection happened in this
//     epoch: the epoch advances, and 64 more probes measure what it left;
//   * the dead fraction of the last 64 checks is the gate. A noticed collection
//     is IGNORED unless at least two thirds of what was checked was dead;
//     otherwise each shard is swept, once, a few slots per registration into
//     it: entries stamped with the current epoch are passed over untouched, the
//     living restamped, the dead removed by backward shift (linear probing's
//     deletion without tombstones — measured, under one slot scanned and 0.2
//     entries moved per removal). Nothing is allocated because of a collection.
//
// A table is replaced only to grow (or to shrink, when a sweep began with it
// under a quarter full and left it under an eighth): incrementally, four entries per registration, into
// a table sized exactly for what it will receive, the old one left unwritten
// so that its probe chains stay valid and a lookup probes the current table,
// then the old. The copy never dereferences, and a shard that is copying does
// no cleaning; its cursor is carried across by scaling (slots are in tag order,
// so slot i becomes about 2i), and an unfinished sweep starts over in the new
// table, where everything already verified is passed by its stamp.
//
// None of this is a requirement on the runtime's collector: if nothing is ever
// found dead there are no sweeps (and nothing was cleared). A lookup always
// dereferences what it returns, so no answer depends on it.
//
// What this replaced, and why (D2, D3): a Map per shard with a
// FinalizationRegistry reporting each death and the bucket surgery deferred to
// idle time. Measured side by side (scripts/experiments/mix-bench.mjs), with
// forced collections and with the engine's own.
//
// All of that rides on registration, and is all a pool needs. Where the host
// offers them, two things take the work off that path (see "Idle time" below):
// a single FinalizationRegistry SENTINEL — one cell, never dereferenced, so it
// does die — says that a collection has happened, and requestIdleCallback or
// setImmediate gives time to answer it: copies are finished first (they are
// cheap, and put lookups back on one table), then the pools are probed, then
// the sweeps that are owed are run, in bounded slices. A registration never
// asks for idle time itself: on a host whose "idle" is the next turn, that put
// a slice after every small operation (measured: ×2.7 on one of them). Measured, this is what
// an application with idle time after a collection needs: without it the dead
// of one burst of work are still in the tables, and in the collector's way,
// when the next begins. Without the sentinel or a scheduler, nothing is lost
// but that: a pool that stops registering keeps its husks (a cleared WeakRef
// and a slot of table each) until registration resumes or the pool is dropped.
//
// Requires WeakRef (ES2021; every supported runtime ships it). Uses
// FinalizationRegistry, requestIdleCallback and setImmediate where they exist.
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
/**
 * …and by a smaller one when a sweep has left it this empty — provided it was
 * under twice this when the sweep BEGAN, its dead included. A table filled by
 * the churn between two collections is the size that churn needs: shrinking it
 * after every sweep made the next burst of work grow it again inside its own
 * operations (measured: ×1.9–2.7 on a short one). A pool that has really
 * collapsed shrinks one answered collection later…
 */
const SHRINK_BELOW = 1 / 8;
/** …in both cases by one sized to end its copy under this load. */
const TARGET_LOAD = 0.45;
/** One registration in this many probes an entry. */
const PROBE_EVERY = 32;
/** The checks the gate looks back over; and the probes that follow a noticed collection, so that the estimate is wholly from after it. */
const WINDOW = 64;
/**
 * A noticed collection is answered only when at least this fraction of the
 * window was dead. It sets the equilibrium: at two thirds the dead number about
 * twice the living at most, a sweep wastes at most one live dereference for
 * every two entries it frees, and (measured on a million live entries under
 * steady churn) operations cost a fifth less than at one half, for more time in
 * collections.
 */
const DEAD_FRACTION = 0.67;
/**
 * What one registration may spend on its shard's sweep or copy. It is paid
 * inside `register`, where a short operation feels it: slots passed (dead and
 * empty ones are cheap)…
 */
const SLOTS_PER_STEP = 16;
/** …living entries dereferenced by a sweep (each a cache miss or two)… */
const LIVE_PER_STEP = 1;
/** …or entries copied to a new table. */
const COPIED_PER_STEP = 4;

// ---------------------------------------------------------------------------
// A pool's census: its epoch, and how dead its recent checks were
// ---------------------------------------------------------------------------

class Census {
  epoch = 1;
  /** The epoch as a stamp: 1…63, never 0, so that a zero word is an empty slot. */
  stamp = 1;
  tick = 0;
  /** The last WINDOW checks, one byte each: 1 found dead. */
  readonly #ring = new Uint8Array(WINDOW);
  #at = 0;
  dead = 0;

  record(dead: 0 | 1): void {
    this.dead += dead - this.#ring[this.#at]!;
    this.#ring[this.#at] = dead;
    this.#at = (this.#at + 1) & (WINDOW - 1);
  }

  /** A collection has been proven. A stamp that survives 63 epochs unrefreshed reads as current again: one entry is passed over once more, and asked the epoch after. */
  advance(): void {
    this.epoch++;
    this.stamp = ((this.epoch - 1) % STAMP_MASK) + 1;
  }
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
  /** Next slot of the old table to copy; everything below it has been copied. */
  cursor = 0;

  /** Where the probes and the sweep stand, and the slots a sweep has yet to pass; zero when none is due. */
  at = 0;
  sweepLeft = 0;
  /** Was the table under a quarter full, its dead included, when this sweep began? */
  sparse = false;
  /** The epoch of the last collection this shard has answered, by a sweep or by deciding against one. */
  answered = 1;
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

/**
 * Dereference `n` entries from the shard's cursor on, whatever their stamps
 * say. The shard is not empty and not being copied: see `register`.
 */
function probe(s: Shard, census: Census, n: number): void {
  const words = s.words;
  const mask = words.length - 1;
  let at = s.at & mask;
  while (n > 0 && s.used > 0) {
    const w = words[at]!;
    if (w !== 0) {
      n--;
      if (s.refs[at]!.deref() === undefined) {
        removeAt(s, at);
        census.record(1);
        if ((w & STAMP_MASK) === census.stamp) {
          // It was alive in this epoch and is dead now: there has been a collection.
          census.advance();
          n = WINDOW;
        }
        continue; // stay: what moved back into this slot has not been looked at
      }
      words[at] = (w & ~STAMP_MASK) | census.stamp;
      census.record(0);
    }
    at = (at + 1) & mask;
  }
  s.at = at;
}

/** A shard answers a noticed collection once: until the next one, nothing more can be found dead. */
function answer(s: Shard, census: Census): void {
  if (s.answered === census.epoch) return;
  s.answered = census.epoch;
  if (census.dead < DEAD_FRACTION * WINDOW) return;
  s.sweepLeft = s.words.length;
  s.sparse = s.used < s.words.length * SHRINK_BELOW * 2;
}

/** One registration's worth of sweeping the current table in place. */
function sweep(s: Shard, census: Census): void {
  const words = s.words;
  const mask = words.length - 1;
  const stamp = census.stamp;
  let at = s.at & mask;
  let left = s.sweepLeft;
  let live = LIVE_PER_STEP;
  for (let slots = SLOTS_PER_STEP; slots > 0 && live > 0 && left > 0; slots--) {
    const w = words[at]!;
    if (w !== 0 && (w & STAMP_MASK) !== stamp) {
      if (s.refs[at]!.deref() === undefined) {
        removeAt(s, at);
        census.record(1);
        continue; // stay, as above
      }
      words[at] = (w & ~STAMP_MASK) | stamp;
      census.record(0);
      live--;
    }
    at = (at + 1) & mask;
    left--;
  }
  s.at = at;
  s.sweepLeft = left;
  if (left <= 0 && s.sparse && s.used < words.length * SHRINK_BELOW) beginCopy(s);
}

/**
 * Retire the current table and begin copying it into a fresh one, sized for
 * what that one will receive: what is copied, and the registrations that
 * arrive meanwhile (one per COPIED_PER_STEP entries, or per SLOTS_PER_STEP
 * slots, whichever is more). Does nothing if that is the size it has.
 */
function beginCopy(s: Shard): void {
  const size = s.words.length;
  const entries = s.used + Math.max(s.used / COPIED_PER_STEP, size / SLOTS_PER_STEP) + 16;
  let bits = MIN_BITS;
  while ((1 << bits) * TARGET_LOAD < entries) bits++;
  if (bits === s.bits) return;
  s.oldBits = s.bits;
  s.oldWords = s.words;
  s.oldRefs = s.refs;
  s.cursor = 0;
  // Slots are in tag order, so the cursor keeps its place in it. An unfinished sweep starts
  // over in the new table: an entry displaced past the cursor here may sit before it there,
  // and what has been verified is stamped, so passing it again asks nothing.
  s.at = bits > s.bits ? s.at << (bits - s.bits) : s.at >> (s.bits - bits);
  if (s.sweepLeft > 0) s.sweepLeft = 1 << bits;
  s.bits = bits;
  s.words = new Int32Array(1 << bits);
  s.refs = new Array<WeakRef<object> | undefined>(1 << bits).fill(undefined);
  s.used = 0;
}

/** One registration's worth of copying. Nothing is dereferenced. */
function copy(s: Shard): void {
  const oldWords = s.oldWords!;
  const end = oldWords.length;
  let c = s.cursor;
  let entries = COPIED_PER_STEP;
  for (let slots = SLOTS_PER_STEP; entries > 0 && slots > 0 && c < end; slots--, c++) {
    const w = oldWords[c]!;
    if (w === 0) continue;
    place(s, w, s.oldRefs[c]!);
    entries--;
  }
  s.cursor = c;
  if (c < end) return;
  s.oldWords = null;
  s.oldRefs = [];
}

// ---------------------------------------------------------------------------
// Idle time
// ---------------------------------------------------------------------------

const IMMEDIATE_SLICE = 256; // shard steps per setImmediate turn (~16 slots each: well under a millisecond)
const IDLE_MIN_SLICE = 16; // always make progress, even on a zero-remaining deadline

/** Every pool, weakly: a dropped pool is not kept by its chores. */
const pools: WeakRef<InternPoolImpl<object>>[] = [];
let scheduled = false;
let collected = false;
let idleEnabled = true;

// Structural globalThis access: this module compiles against neither the
// DOM nor the Node ambient globals. Looked up at schedule time, not import
// time — one typeof per slice, and a test can install a fake.
interface IdleDeadline {
  timeRemaining(): number;
}
const _g = globalThis as {
  requestIdleCallback?: (cb: (deadline: IdleDeadline) => void) => unknown;
  setImmediate?: (cb: () => void) => unknown;
};

/** Ask for idle time, if the host has any to give. Returns whether a slice is (now) scheduled. */
function scheduleIdle(): boolean {
  if (scheduled) return true;
  if (typeof _g.requestIdleCallback === 'function') {
    scheduled = true;
    _g.requestIdleCallback(runIdle);
  } else if (typeof _g.setImmediate === 'function') {
    scheduled = true;
    _g.setImmediate(runIdle);
  }
  return scheduled;
}

/** One slice: bounded by the host's deadline where there is one, by a step count otherwise. */
function runIdle(deadline?: IdleDeadline): void {
  scheduled = false;
  if (!idleEnabled) return;
  let steps = 0;
  const spent =
    deadline === undefined
      ? () => ++steps >= IMMEDIATE_SLICE
      : () => ++steps >= IDLE_MIN_SLICE && deadline.timeRemaining() <= 1;
  collected = false;
  let more = false;
  for (let i = pools.length - 1; i >= 0 && !more; i--) {
    const pool = pools[i]!.deref();
    if (pool === undefined) {
      pools.splice(i, 1);
      continue;
    }
    pool._notice(); // (a pool that has not registered since it last looked does not look again)
    more = pool._idle(spent);
  }
  if (more) scheduleIdle();
}

// The sentinel: an object nothing holds, registered and never looked at — so,
// unlike anything a pool dereferences, it dies with the next collection, and
// the engine says so. One cell, re-armed each time. The registry must be
// reachable from a module-level binding: an unreferenced FinalizationRegistry
// is itself collected and its callbacks silently stop (measured, not theorized).
const sentinel =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<undefined>(() => {
        armSentinel();
        if (!idleEnabled) return;
        collected = true;
        // No scheduler (and a host that may run this outside any task): one bounded slice, here.
        if (!scheduleIdle()) runIdle();
      })
    : undefined;

function armSentinel(): void {
  sentinel?.register({}, undefined);
}
armSentinel();

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
  readonly #census = new Census();
  /** Idle time: the shard to resume at, and the census tick when this pool last probed for a collection. */
  #idleAt = 0;
  #noticedAt = -1;

  lookup(hash: number, predicate: (candidate: T) => boolean): T | undefined {
    const stamp = this.#census.stamp;
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
    const census = this.#census;
    const m = Math.imul(hash, 0x9e3779b1);
    const s = (this.#shards[m >>> (32 - SHARD_BITS)] ??= new Shard());

    if (s.oldWords !== null) {
      copy(s); // and no cleaning meanwhile
    } else {
      if ((++census.tick & (PROBE_EVERY - 1)) === 0 && s.used > 0) probe(s, census, 1);
      answer(s, census);
      if (s.used >= s.words.length * GROW_AT) beginCopy(s);
      else if (s.sweepLeft > 0) sweep(s, census);
    }
    place(s, (m << SHARD_BITS) | census.stamp, new WeakRef<object>(value));
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

  /** @internal A collection has happened: probe, as a registration would have. Only a pool that has registered since it last looked. */
  _notice(): void {
    const census = this.#census;
    if (census.tick === this.#noticedAt) return;
    this.#noticedAt = census.tick;
    for (const s of this.#shards) {
      if (s === undefined || s.oldWords !== null || s.used === 0) continue;
      probe(s, census, WINDOW);
      return;
    }
  }

  /** @internal Idle time: finish copies, answer the noticed collection, run the sweeps owed — until `spent()`. Returns whether work is left. */
  _idle(spent: () => boolean): boolean {
    const census = this.#census;
    for (let n = 0; n < SHARDS; n++) {
      const s = this.#shards[(this.#idleAt + n) & (SHARDS - 1)];
      if (s === undefined) continue;
      for (;;) {
        if (s.oldWords !== null) copy(s);
        else {
          answer(s, census);
          if (s.sweepLeft <= 0) break;
          sweep(s, census);
        }
        if (spent()) {
          this.#idleAt = (this.#idleAt + n) & (SHARDS - 1);
          return true;
        }
      }
    }
    return false;
  }

  /** @internal Test-only: entries stored (live, or dead and not yet dropped), the slots of every table, and the shards with a table being copied or a sweep under way. */
  _stats(): { slots: number; capacity: number; migrating: number; sweeping: number; epoch: number } {
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
    return { slots, capacity, migrating, sweeping, epoch: this.#census.epoch };
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
  const pool = new InternPoolImpl<T>();
  pools.push(new WeakRef(pool as unknown as InternPoolImpl<object>));
  return pool;
}

// ---------------------------------------------------------------------------
// Test-only inspection hooks (not exported from the package barrel)
// ---------------------------------------------------------------------------

/** @internal Test-only: entries a pool stores (live, or dead and not yet dropped), the slots of all its tables, and how many shards have a table being copied, or a sweep under way. */
export function _poolStats(pool: InternPool<object>): { slots: number; capacity: number; migrating: number; sweeping: number; epoch: number } {
  return (pool as InternPoolImpl<object>)._stats();
}

/** @internal Test-only: switch the idle driver off (what is left is the registration-driven path every host has) or back on. */
export function _idleDriver(enabled: boolean): void {
  idleEnabled = enabled;
  collected = false;
}

/** @internal Test-only: is an idle slice scheduled, and has a collection been reported that no slice has yet acted on? */
export function _idleState(): { scheduled: boolean; collected: boolean } {
  return { scheduled, collected };
}
