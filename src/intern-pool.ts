// ---------------------------------------------------------------------------
// intern-pool — weak pools; rehashing the index is what buries the dead.
//
// A pool is 64 open-addressed tables (linear probing), sharded by hash and
// created on first use: see SHARDS. A slot is one int32 WORD in an Int32Array
// — 26 bits of the multiplied hash above a 6-bit epoch STAMP — beside the
// WeakRef to the pooled object in a parallel array. The hash is multiplied
// first (Fibonacci hashing, a bijection on 32 bits): its top 6 bits choose the
// shard and the other 26 are the word's tag, so a tag match within a shard IS
// full 32-bit hash equality, and a lookup offers the predicate exactly the
// candidates registered under that hash. A miss — the path of every fresh
// node — reads the Int32Array alone, sixteen slots to a cache line.
//
// Nothing is ever deleted from a table. A table is replaced: inserts go to the
// current table while each one also moves ONE live entry across from the old
// table, and a dead entry is simply not moved. Growing the index and burying
// the dead are therefore the same incremental copy, and neither is ever one
// long task. The old table is not written while it drains, so its probe
// chains stay valid and a lookup probes the current table, then the old one.
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
//     the current epoch is moved without being asked;
//   * a collection is otherwise IGNORED unless a 64-slot sample finds at least
//     half of the pool dead. Below that, growth is a plain copy. A lap that
//     dereferences a shard therefore frees about half of it or more, which
//     bounds the dead at about the number of the living, and the asking at
//     about one live deref per death. The sample is taken ONCE per pool per
//     epoch, from whichever shard is registered into first: shards are random
//     partitions of one population, so its answer is every shard's. (Sampling
//     each shard put 64 samples — a few µs apiece — on the first registrations
//     after every collection, which is where a benchmark row, or a request,
//     begins.)
//
// The canary is a hint, not a requirement on the runtime: if it never clears
// there are no verifying laps (and nothing was cleared); if it clears often
// there are more of them. A lookup always dereferences what it returns, so no
// answer ever depends on it.
//
// What this replaced, and why (D2, D3): a Map per shard with a FinalizationRegistry
// reporting each death and the bucket surgery deferred to idle time. Measured
// side by side over mixes of inserts, hits and deaths, with collections forced
// at fixed intervals (scripts/experiments/mix-bench.mjs), this index is level
// or ahead per operation, spends a twentieth of the time in the event-loop
// turns after a collection, and ends every scenario holding less memory. It
// also asks less of the host: no finalization callbacks (which some runtimes
// run without an I/O context, or not at all), no timers, no idle callbacks.
//
// What it costs: cleanup rides on registration. A pool that stops registering
// stops burying its dead — the husks (a cleared WeakRef and eight bytes of
// table each) stay until registration resumes or the pool is dropped.
//
// Requires WeakRef (ES2021; every supported runtime ships it).
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';

/**
 * The index is SHARDS tables, not one. A cycle begins by allocating the next
 * table whole — measured, 1.6 ms for a million slots and 25 ms for eight
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
/** A table is replaced when half full… */
const GROW_AT = 0.5;
/** …by one sized to finish its migration under this load… */
const TARGET_LOAD = 0.45;
/** …and if the survivor estimate was too low, the migration is finished at once past this one. */
const FINISH_AT = 0.75;
/** Occupied slots dereferenced to estimate a shard's survivors. */
const SAMPLE = 64;
/** A shard is verified only when the sample finds at least this fraction dead. */
const DEAD_FRACTION = 0.5;
/** Added to the sampled survivor fraction when sizing: 64 slots estimate to within about ±0.06. */
const SIZING_MARGIN = 0.1;
/**
 * Slots of the old table the migration may pass per registration. Passing a
 * dead or empty slot is cheap (~6 ns) but it is paid inside `register`, in the
 * registrations that follow a collection: at 64 it added ~0.4 µs to each, which
 * a short operation feels; at 16, ~0.1 µs over a lap four times as long.
 */
const SLOTS_PER_STEP = 16;
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
// A shard: the current table, and the old one while it drains
// ---------------------------------------------------------------------------

class Shard {
  bits = MIN_BITS;
  words = new Int32Array(1 << MIN_BITS);
  refs: (WeakRef<object> | undefined)[] = new Array<WeakRef<object> | undefined>(1 << MIN_BITS).fill(undefined);
  used = 0;

  oldBits = 0;
  oldWords: Int32Array | null = null;
  oldRefs: (WeakRef<object> | undefined)[] = [];
  /** Next slot of the old table to move; everything below it has been moved or dropped. */
  cursor = 0;
  /** Does this migration dereference (a lap that follows a collection), or copy? */
  verify = false;
  /** The epoch of the last collection this shard has answered, by a lap or by deciding against one. */
  answered = epoch;
}

/** Store `word` (tag and stamp) and its ref in the current table. The table is never full: see `register`. */
function place(s: Shard, word: number, ref: WeakRef<object>): void {
  const words = s.words;
  const mask = words.length - 1;
  let i = (word & ~STAMP_MASK) >>> (32 - s.bits);
  while (words[i] !== 0) i = (i + 1) & mask;
  words[i] = word;
  s.refs[i] = ref;
  s.used++;
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

/** The smallest table that ends a migration of `entries` under TARGET_LOAD. */
function bitsFor(entries: number): number {
  let bits = MIN_BITS;
  while ((1 << bits) * TARGET_LOAD < entries) bits++;
  return bits;
}

/** Retire the current table and begin moving it into a fresh one. */
function beginMigration(s: Shard, survivors: number, verify: boolean): void {
  s.oldBits = s.bits;
  s.oldWords = s.words;
  s.oldRefs = s.refs;
  s.cursor = 0;
  s.verify = verify;
  // The lap lasts one registration per survivor moved, or per SLOTS_PER_STEP
  // slots passed, whichever is more — and the new table receives them all.
  const moved = s.used * Math.min(1, survivors + SIZING_MARGIN);
  s.bits = bitsFor(moved + Math.max(moved, s.words.length / SLOTS_PER_STEP) + 16);
  s.words = new Int32Array(1 << s.bits);
  s.refs = new Array<WeakRef<object> | undefined>(1 << s.bits).fill(undefined);
  s.used = 0;
}

/** Move up to `entries` live entries across, passing at most `slots` slots of the old table. */
function migrate(s: Shard, entries: number, slots: number): void {
  const oldWords = s.oldWords!;
  const end = oldWords.length;
  let c = s.cursor;
  while (entries > 0 && slots-- > 0 && c < end) {
    const w = oldWords[c]!;
    if (w !== 0) {
      const ref = s.oldRefs[c]!;
      if (!s.verify || (w & STAMP_MASK) === stamp) {
        place(s, w, ref);
        entries--;
      } else if (ref.deref() !== undefined) {
        place(s, (w & ~STAMP_MASK) | stamp, ref);
        entries--;
      }
      // else: dead, and not moving it is the whole of its burial
    }
    c++;
  }
  s.cursor = c;
  if (c >= end) {
    s.oldWords = null;
    s.oldRefs = [];
  }
}

/**
 * The current table is filling before the old one has drained: the survivor
 * sample was too low. Move what the current table holds (stamps kept, nothing
 * asked) into one sized for everything still stored, and drain the old table
 * into that. The one step here that is not incremental; it is a shard's worth.
 */
function finishMigration(s: Shard): void {
  const oldWords = s.oldWords!;
  let rest = 0;
  for (let c = s.cursor; c < oldWords.length; c++) if (oldWords[c] !== 0) rest++;
  const words = s.words;
  const refs = s.refs;
  s.bits = bitsFor(s.used + rest + 16);
  s.words = new Int32Array(1 << s.bits);
  s.refs = new Array<WeakRef<object> | undefined>(1 << s.bits).fill(undefined);
  s.used = 0;
  for (let i = 0; i < words.length; i++) if (words[i] !== 0) place(s, words[i]!, refs[i]!);
  migrate(s, oldWords.length, oldWords.length);
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * A typed, weakly-held pool of canonical instances of `T`.
 *
 * Members are retained via `WeakRef` and leave the pool once nothing else
 * references them: a member the garbage collector has taken is dropped from
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
      migrate(s, 1, SLOTS_PER_STEP);
      if (s.oldWords !== null && s.used >= s.words.length * FINISH_AT) finishMigration(s);
    }
    if (s.oldWords === null) {
      const full = s.used >= s.words.length * GROW_AT;
      if (s.answered !== epoch && (full || s.used > IGNORE_BELOW)) {
        // A shard answers a collection once: until the next one, nothing more can be found dead.
        s.answered = epoch;
        if (this.#sampled !== epoch) {
          this.#sampled = epoch;
          this.#survivors = sampleSurvivors(s);
        }
        if (1 - this.#survivors >= DEAD_FRACTION) beginMigration(s, this.#survivors, true);
        else if (full) beginMigration(s, 1, false);
      } else if (full) {
        beginMigration(s, 1, false);
      }
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

  /** @internal Test-only: entries stored (live, or dead and not yet dropped), the slots of every table, and the shards with a table draining. */
  _stats(): { slots: number; capacity: number; migrating: number } {
    let slots = 0;
    let capacity = 0;
    let migrating = 0;
    for (const s of this.#shards) {
      if (s === undefined) continue;
      slots += s.used;
      capacity += s.words.length;
      if (s.oldWords === null) continue;
      migrating++;
      capacity += s.oldWords.length;
      for (let i = s.cursor; i < s.oldWords.length; i++) if (s.oldWords[i] !== 0) slots++;
    }
    return { slots, capacity, migrating };
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

/** @internal Test-only: entries a pool stores (live, or dead and not yet dropped), the slots of all its tables, and how many shards have a table draining. */
export function _poolStats(pool: InternPool<object>): { slots: number; capacity: number; migrating: number } {
  return (pool as InternPoolImpl<object>)._stats();
}

/** @internal Test-only: the GC epoch — how many times the canary has been seen gone, plus one. */
export function _epoch(): number {
  return epoch;
}
