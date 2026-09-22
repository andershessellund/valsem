// The weak-pool machinery: sharded open tables, swept in place after a
// collection, and replaced incrementally to grow or shrink.
//
// Placement, exact-hash matching and growth are deterministic. Reclamation
// needs real GC — a WeakRef is cleared only by a collection, and the pool
// learns of one by finding one of its own entries dead — and those tests skip
// themselves when globalThis.gc is unavailable (vitest.config.ts passes
// --expose-gc to workers, so normally they run). The last of them forces
// nothing: the engine's own collections, mid-job and incremental, are the
// normal case, and a mechanism that only works between forced ones does not work.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createInternPool, _poolStats, _idleDriver, _idleState } from './intern-pool.js';
import { intern } from './intern.js';
import { equals, hashCode, interned } from './deep-equal.js';

const gc = (globalThis as { gc?: () => void }).gc;
const hasGC = typeof gc === 'function';
type G = { requestIdleCallback?: unknown; setImmediate?: unknown };
const g = globalThis as G;
const realSetImmediate = setImmediate;
const turn = (): Promise<void> => new Promise((r) => realSetImmediate(r));

// Everything up to the last group is about what every host has: cleanup that
// rides on registration. The idle driver would do that work first.
beforeAll(() => _idleDriver(false));

/**
 * Repeated gc + macrotask turns until `cond` holds (or rounds run out).
 *
 * The job boundary BEFORE gc() is essential: `new WeakRef(x)` and
 * `WeakRef.deref()` (which the condition typically performs, via size()) put
 * their target on the agent's [[KeptAlive]] list until the current job ends,
 * so a gc() in the same job treats every such object as a root.
 */
async function collectUntil(cond: () => boolean, rounds = 20): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await turn();
    gc!();
    await turn();
  }
  return cond();
}

// The pool multiplies a hash by G and reads the product: its top 6 bits are
// the shard, the 26 below them the slot order and the tag. G is odd, so the
// multiplication has an inverse, and a test can ask for the product it wants.
const G = 0x9e3779b1;
let G_INVERSE = G;
for (let i = 0; i < 5; i++) G_INVERSE = Math.imul(G_INVERSE, 2 - Math.imul(G, G_INVERSE));
const hashWithProduct = (m: number): number => Math.imul(m, G_INVERSE) >>> 0;

class Point {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;
  constructor(
    readonly x: number,
    readonly y: number,
  ) {
    (this as Record<symbol, unknown>)[hashCode as unknown as symbol] =
      ((x * 73856093) ^ (y * 19349663)) >>> 0;
  }
  [equals](other: unknown): boolean {
    return other instanceof Point && other.x === this.x && other.y === this.y;
  }
}

describe('InternPool — the index is sharded', () => {
  it('finds every member again, whatever bits its hash has', () => {
    // Low-entropy hashes (a consumer's `x + 31 * y`), high-bit-only hashes and
    // well-mixed ones: every member is found under its own hash, and no other.
    const pool = createInternPool<{ v: number }>();
    const members: [{ v: number }, number][] = [];
    for (let i = 0; i < 3000; i++) {
      const hash = i % 3 === 0 ? i : i % 3 === 1 ? (i << 20) >>> 0 : Math.imul(i, 0x85ebca6b) >>> 0;
      members.push([pool.register({ v: i }, hash), hash]);
    }
    expect(_poolStats(pool).slots).toBe(3000);
    for (const [member, hash] of members) {
      expect(pool.lookup(hash, (c) => c === member)).toBe(member);
    }
    expect(pool.lookup(0xdeadbeef, () => true)).toBeUndefined();
    expect(pool.size()).toBe(3000);
  });

  it('members that share a full hash are told apart by the predicate', () => {
    const pool = createInternPool<{ v: number }>();
    const a = pool.register({ v: 1 }, 0xcafe);
    const b = pool.register({ v: 2 }, 0xcafe);
    expect(_poolStats(pool).slots).toBe(2);
    expect(pool.lookup(0xcafe, (c) => c.v === 2)).toBe(b);
    expect(pool.lookup(0xcafe, (c) => c.v === 1)).toBe(a);
  });

  it('a lookup offers the predicate only what was registered under exactly that hash', () => {
    // A slot keeps 26 bits of the multiplied hash and its shard implies the
    // other 6: flip any one bit of the product and it is a different hash,
    // in this shard or another, and must not be offered.
    const pool = createInternPool<{ v: number }>();
    const product = 0x12345678;
    const member = pool.register({ v: 1 }, hashWithProduct(product));
    expect(pool.lookup(hashWithProduct(product), () => true)).toBe(member);
    for (let bit = 0; bit < 32; bit++) {
      expect(pool.lookup(hashWithProduct(product ^ (1 << bit)), () => true)).toBeUndefined();
    }
  });
});

describe('InternPool — canonicality', () => {
  it('intern() collapses equal instances to one ===', () => {
    const pool = createInternPool<Point>();
    const a = pool.intern(new Point(1, 2));
    const b = pool.intern(new Point(1, 2));
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect((a as unknown as Record<symbol, unknown>)[interned as unknown as symbol]).toBe(true);
    expect(pool.intern(new Point(3, 4))).not.toBe(a);
  });

  it('intern() of what is already canonical is that very object, without a lookup', () => {
    const pool = createInternPool<Point>();
    const a = pool.intern(new Point(1, 2));
    expect(pool.intern(a)).toBe(a);
    const other = createInternPool<Point>();
    expect(other.intern(a)).toBe(a); // the marker is the claim, whichever pool made it
    expect(other.size()).toBe(0);
  });

  it('lookup/register honors predicates among members of one hash (forced collision)', () => {
    const pool = createInternPool<{ v: number }>();
    const a = pool.register({ v: 1 }, 42);
    const b = pool.register({ v: 2 }, 42);
    const c = pool.register({ v: 3 }, 42);
    expect(pool.lookup(42, (x) => x.v === 1)).toBe(a);
    expect(pool.lookup(42, (x) => x.v === 2)).toBe(b);
    expect(pool.lookup(42, (x) => x.v === 3)).toBe(c);
    expect(pool.lookup(42, (x) => x.v === 4)).toBeUndefined();
    expect(pool.lookup(7, () => true)).toBeUndefined();
    expect(pool.size()).toBe(3);
    expect(_poolStats(pool).slots).toBe(3);
  });

  it('one slot per member; size counts the live ones', () => {
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    for (let i = 0; i < 100; i++) held.push(pool.register({ v: i }, i));
    expect(_poolStats(pool).slots).toBe(100);
    expect(pool.size()).toBe(100);
    expect(held.length).toBe(100);
  });
});

describe('InternPool — growth is incremental', () => {
  it('every member stays findable while tables are being replaced', () => {
    // A table is replaced a few entries per registration, so for part of this loop
    // a shard has two tables and a member may be in either.
    const pool = createInternPool<{ v: number }>();
    const hashOf = (i: number): number => Math.imul(i + 1, 0x85ebca6b) >>> 0;
    const members: { v: number }[] = [];
    let twoTables = 0;
    for (let i = 0; i < 50_000; i++) {
      members.push(pool.register({ v: i }, hashOf(i)));
      if (i % 997 !== 0) continue;
      const stats = _poolStats(pool);
      expect(stats.slots).toBe(i + 1);
      if (stats.migrating > 0) twoTables++;
      for (let k = 0; k < 40; k++) {
        const j = Math.imul(k + 1, 2654435761) % (i + 1);
        const at = j < 0 ? -j : j;
        expect(pool.lookup(hashOf(at), (c) => c.v === at)).toBe(members[at]);
      }
    }
    expect(twoTables).toBeGreaterThan(0);
    for (let i = 0; i < members.length; i++) {
      expect(pool.lookup(hashOf(i), (c) => c.v === i)).toBe(members[i]);
    }
    expect(_poolStats(pool).slots).toBe(50_000);
    expect(pool.size()).toBe(50_000);
    // Half full at most, a quarter full after a replacement: never sparser than an eighth.
    expect(_poolStats(pool).capacity).toBeLessThan(50_000 * 16);
  });
});

describe.skipIf(!hasGC)('InternPool — reclamation (needs --expose-gc)', () => {
  it('the dead are swept out, in place, as registration continues — and not before', async () => {
    const pool = createInternPool<{ v: number }>();
    // Register in a callee so nothing on this frame retains the values. About
    // 400 to a shard: its table of 1024 slots is settled (see the next test).
    (function registerDoomed() {
      for (let i = 0; i < 25_600; i++) pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
    })();
    expect(await collectUntil(() => pool.size() === 0)).toBe(true);
    // Cleared, and still stored; and nobody has noticed: cleanup rides on registration.
    expect(_poolStats(pool)).toMatchObject({ slots: 25_600, migrating: 0, sweeping: 0, epoch: 1 });

    const held: object[] = [];
    const capacity = _poolStats(pool).capacity;
    for (let i = 0; i < 2_000; i++) held.push(pool.register({ v: i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    // A probe found an entry of this epoch dead; the probes after it found nearly everything
    // dead; every shard is being swept — in place: no table has been replaced, none allocated.
    const during = _poolStats(pool);
    expect(during).toMatchObject({ epoch: 2, sweeping: 64, migrating: 0, capacity });
    expect(during.slots).toBeLessThan(22_000);

    for (let i = 2_000; i < 14_000; i++) held.push(pool.register({ v: i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    expect(_poolStats(pool)).toMatchObject({ slots: 14_000, sweeping: 0, epoch: 2 });
    expect(pool.size()).toBe(14_000);
    expect(held.length).toBe(14_000);
  });

  it('a collection that took less than two thirds of what was checked is noticed, and ignored', async () => {
    // About 400 to a shard: past the copy that began at 256 and short of the next at 512.
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    (function registerSome() {
      for (let i = 0; i < 25_600; i++) {
        const member = pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
        if (i % 2 !== 0) held.push(member); // half are doomed
      }
    })();
    expect(_poolStats(pool).migrating).toBe(0);
    expect(await collectUntil(() => pool.size() === 12_800)).toBe(true);
    for (let i = 0; i < 2_000; i++) held.push(pool.register({ v: -i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    // Half dead is not worth dereferencing the other half. (What the probes themselves met dead is gone.)
    const stats = _poolStats(pool);
    expect(stats).toMatchObject({ epoch: 2, migrating: 0, sweeping: 0 });
    expect(stats.slots).toBeGreaterThan(27_400);
    expect(pool.size()).toBe(14_800);
  });

  it('survivors stay canonical across reclamation', async () => {
    const pool = createInternPool<Point>();
    const keep = pool.intern(new Point(9, 9));
    (function registerDoomed() {
      for (let i = 0; i < 5_000; i++) pool.intern(new Point(i, 1000));
    })();
    expect(await collectUntil(() => pool.size() === 1)).toBe(true);
    const held: Point[] = [];
    for (let i = 0; i < 6_000; i++) held.push(pool.intern(new Point(i, 2000)));
    expect(_poolStats(pool).epoch).toBeGreaterThan(1);
    expect(pool.intern(new Point(9, 9))).toBe(keep);
    expect(pool.size()).toBe(6_001);
    for (let i = 0; i < 6_000; i += 97) expect(pool.intern(new Point(i, 2000))).toBe(held[i]);
  });

  // The next three choose where members sit: the top 6 bits of a product are
  // its shard, and a member's home slot is the top bits of the rest.
  type Crafted = ReturnType<typeof createInternPool<{ m: number }>>;
  const crafted = async (doomed: number[], heldProducts: number[], heldFirst = false) => {
    const pool: Crafted = createInternPool<{ m: number }>();
    const held = new Map<number, { m: number }>();
    (function registerAll() {
      if (heldFirst) for (const m of heldProducts) held.set(m, pool.register({ m }, hashWithProduct(m)));
      for (const m of doomed) pool.register({ m }, hashWithProduct(m));
      if (!heldFirst) for (const m of heldProducts) held.set(m, pool.register({ m }, hashWithProduct(m)));
    })();
    expect(await collectUntil(() => pool.size() === heldProducts.length)).toBe(true);
    return { pool, held };
  };
  /** `count` more held members, spread over one shard (a product's top 6 bits), `salt` keeping batches apart. */
  const registerHeld = (pool: Crafted, held: Map<number, { m: number }>, shard: number, salt: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const m = (shard << 26) | (Math.imul(k + salt, 0x85ebca6b) >>> 6);
      if (!held.has(m)) held.set(m, pool.register({ m }, hashWithProduct(m)));
    }
  };
  const expectAllFound = (pool: Crafted, held: Map<number, { m: number }>) => {
    for (const [m, member] of held) expect(pool.lookup(hashWithProduct(m), (c) => c.m === m)).toBe(member);
  };

  it('removing the dead from a probe cluster leaves the rest of it findable', async () => {
    // Six members share a home slot (they differ below the bits that choose it),
    // so they sit in a run: the first and third die, the others must move back.
    const cluster = [1, 2, 3, 4, 5, 6].map((k) => (5 << 20) | k);
    const fillers = Array.from({ length: 120 }, (_, j) => (j + 10) << 16);
    const { pool, held } = await crafted([cluster[0]!, cluster[2]!, ...fillers], [cluster[1]!, cluster[3]!, cluster[4]!, cluster[5]!]);
    // The shard grows first, and cleans nothing while it does; then its sweep takes one
    // registration for each of the living that were registered before the collection.
    registerHeld(pool, held, 0, 1, 240);
    expect(_poolStats(pool)).toMatchObject({ slots: held.size, sweeping: 0, epoch: 2 });
    expectAllFound(pool, held);
    expect(pool.lookup(hashWithProduct(cluster[0]!), () => true)).toBeUndefined();
  });

  it('…also when the cluster wraps around the end of the table', async () => {
    // Home is the LAST slot, so the run continues at slot 0.
    const cluster = [1, 2, 3, 4, 5].map((k) => 0x3ffff00 | k);
    const fillers = Array.from({ length: 120 }, (_, j) => (j + 10) << 16);
    const { pool, held } = await crafted([cluster[0]!, cluster[1]!, ...fillers], [cluster[2]!, cluster[3]!, cluster[4]!]);
    registerHeld(pool, held, 0, 1, 240);
    expect(_poolStats(pool)).toMatchObject({ slots: held.size, sweeping: 0, epoch: 2 });
    expectAllFound(pool, held);
  });

  it('a shard that must grow in the middle of a sweep does no cleaning while it copies, and resumes after', async () => {
    // Shard 0: 600 held at low slots, 1,300 doomed at high ones, in 4,096 slots — 148 short
    // of growing. The held go in first, so the probes made on the way leave the cursor
    // among them: the sweep then crawls (one living entry per registration) through
    // hundreds of the living before it meets the dead, and the table fills first.
    // Shard 1 is all doomed: it is where the collection gets noticed (a probe looks
    // where registration happens).
    const heldLow = Array.from({ length: 600 }, (_, j) => (j + 1) << 14); // home slots 1…600 of 4,096
    const doomedHigh = Array.from({ length: 1_300 }, (_, j) => (2_048 + Math.floor(j * 1.5)) << 14); // 2,048…3,997
    const doomedElsewhere = Array.from({ length: 200 }, (_, j) => (1 << 26) | ((j + 1) << 17));
    const { pool, held } = await crafted([...doomedHigh, ...doomedElsewhere], heldLow, true);
    expect(_poolStats(pool)).toMatchObject({ slots: 2_100, migrating: 0, epoch: 1 });

    registerHeld(pool, held, 1, 1, 40); // into shard 1: noticed, measured, worth a sweep
    expect(_poolStats(pool).epoch).toBe(2);
    registerHeld(pool, held, 0, 1, 200); // into shard 0: its sweep begins, and then it has to grow
    expect(_poolStats(pool)).toMatchObject({ migrating: 1, sweeping: 2 }); // shard 0's is owed, not dropped
    expectAllFound(pool, held); // in either table — and being found alive is noted, so the sweep will not ask

    registerHeld(pool, held, 0, 10_000, 4_000);
    registerHeld(pool, held, 1, 10_000, 200);
    expect(_poolStats(pool)).toMatchObject({ slots: held.size, sweeping: 0 });
    expect(pool.size()).toBe(held.size);
    expectAllFound(pool, held);
  });

  it('a table shrinks when a sweep both finds and leaves it nearly empty — not merely because it was swept', async () => {
    // One shard, so the counts are exact.
    const pool: Crafted = createInternPool<{ m: number }>();
    const held = new Map<number, { m: number }>();
    const doom = (salt: number, count: number): void => {
      for (let k = 0; k < count; k++) {
        const m = Math.imul(k + salt, 0xc2b2ae35) >>> 6;
        pool.register({ m }, hashWithProduct(m));
      }
    };
    doom(1, 1_600); // 4,096 slots
    expect(_poolStats(pool)).toMatchObject({ slots: 1_600, capacity: 4_096, migrating: 0 });
    expect(await collectUntil(() => pool.size() === 0)).toBe(true);

    (function nextBurst() {
      doom(100_000, 400);
      registerHeld(pool, held, 0, 1, 40);
    })();
    // Swept: but this table was the size its contents needed, and the next burst may need it again.
    expect(_poolStats(pool)).toMatchObject({ slots: 440, sweeping: 0, migrating: 0, capacity: 4_096 });

    // 440 in 4,096 slots, most of them about to die: under a quarter full before the sweep…
    expect(await collectUntil(() => pool.size() === 40)).toBe(true);
    registerHeld(pool, held, 0, 10_000, 700);
    // …and under an eighth after it: now it is replaced by a smaller one.
    expect(_poolStats(pool)).toMatchObject({ slots: held.size, sweeping: 0, migrating: 0, capacity: 2_048 });
    expectAllFound(pool, held);
  });

  it('a table of the smallest size has nothing smaller to shrink to', async () => {
    // Shard 0 holds eleven members in its first 64 slots; shard 1 is where the collection is noticed.
    const few = Array.from({ length: 10 }, (_, j) => (j + 1) << 20);
    const elsewhere = Array.from({ length: 200 }, (_, j) => (1 << 26) | ((j + 1) << 17));
    const { pool, held } = await crafted([...few, ...elsewhere], [11 << 20]);
    const capacity = _poolStats(pool).capacity;
    registerHeld(pool, held, 1, 1, 120); // noticed, worth a sweep — and shard 1 is done with its own
    registerHeld(pool, held, 0, 1, 7); // shard 0: swept down to 8 of its 64 slots, and left at that
    expect(_poolStats(pool)).toMatchObject({ slots: held.size, sweeping: 0, migrating: 0, capacity });
    expectAllFound(pool, held);
  });

  it('a predicate that registers into the pool moves nothing under the lookup that called it', async () => {
    // A cluster [D, X] under one hash, D dead. A lookup for X calls its predicate on X;
    // the predicate registers into the same shard, at a moment when a sweep is owed
    // and would remove D — shifting X back into the slot the lookup is looking at.
    // If it did, the lookup would restamp an empty slot (a word with no WeakRef) and
    // go on from a slot past X.
    const h = hashWithProduct((1 << 20) | 1);
    const pool: Crafted = createInternPool<{ m: number }>();
    const held: { m: number }[] = [];
    (function registerAll() {
      pool.register({ m: 0 }, h); // D
      held.push(pool.register({ m: 1 }, h)); // X
      for (let k = 0; k < 1000; k++) pool.register({ m: -k }, hashWithProduct((1 << 26) | ((k + 1) << 15))); // doomed, shard 1
    })();
    expect(await collectUntil(() => pool.size() === 1)).toBe(true);
    for (let k = 0; k < 400 && _poolStats(pool).epoch < 2; k++) held.push(pool.register({ m: 5000 + k }, hashWithProduct((1 << 26) | ((k + 5000) << 8))));
    expect(_poolStats(pool)).toMatchObject({ epoch: 2 });
    const X = held[0]!;
    let inside = 0;
    const found = pool.lookup(h, (c) => {
      for (let k = 0; k < 40; k++) held.push(pool.register({ m: 9000 + k }, hashWithProduct((40 << 20) | (k << 8)))); // shard 0, mid-lookup
      inside++;
      return c === X;
    });
    expect(found).toBe(X);
    expect(inside).toBe(1);
    // Nothing was swept during the lookup; the next registration sweeps D away; everything is consistent.
    held.push(pool.register({ m: 9999 }, hashWithProduct(41 << 20)));
    for (let k = 0; k < 200; k++) held.push(pool.register({ m: 10_000 + k }, hashWithProduct((42 << 20) | (k << 8))));
    expect(pool.lookup(h, (c) => c === X)).toBe(X);
    expect(pool.lookup(h, (c) => c.m === 0)).toBeUndefined();
    expect(pool.size()).toBe(held.length); // (walks every slot: a word without a WeakRef beside it would throw)
  });

  it('…through the public API: an [equals] that interns while comparing', async () => {
    // (What the previous test guards against, seen from a consumer: a duplicate
    // canonical instance, or a pool that throws afterwards.)
    let armed = false;
    class K {
      declare readonly [hashCode]: number;
      constructor(readonly id: number) {
        (this as Record<symbol, unknown>)[hashCode as unknown as symbol] = 0x5eed;
      }
      [equals](o: unknown): boolean {
        if (armed) {
          armed = false;
          for (let k = 0; k < 40; k++) intern(['side', k, Math.random()]);
        }
        return o instanceof K && o.id === this.id;
      }
    }
    const held: unknown[] = [];
    (function registerAll() {
      intern(new K(0)); // doomed
      held.push(intern(new K(1)));
      held.push(intern(new K(2)));
      for (let k = 0; k < 3000; k++) intern(['filler', k]); // doomed: enough for the collection to be noticed
    })();
    for (let i = 0; i < 20; i++) {
      await turn();
      gc!();
      await turn();
    }
    for (let k = 0; k < 300; k++) held.push(intern(['after', k]));
    const X = held[1];
    armed = true;
    expect(intern(new K(2))).toBe(X);
    expect(intern(new K(1))).toBe(held[0]);
    expect(intern(new K(2))).toBe(X);
  });

  it('what dies after an ignored collection is found by the probes, and swept when the window says so', async () => {
    // 100k long-lived and 3k short-lived: the collection that takes the 3k is noticed and
    // ignored (3 % dead). Then the 100k die — all stamped with the previous epoch, so no
    // probe can prove a collection with them. They are still dead, and the probes find them.
    const pool = createInternPool<{ n: number }>();
    let n = 0;
    const reg = (): { n: number } => pool.register({ n }, Math.imul(++n, 0x85ebca6b) >>> 0);
    let A: object[] | null = [];
    const B: object[] = [];
    (function registerAll() {
      for (let i = 0; i < 100_000; i++) A!.push(reg());
      for (let i = 0; i < 3_000; i++) reg();
    })();
    expect(await collectUntil(() => pool.size() === 100_000)).toBe(true);
    for (let i = 0; i < 20_000 && _poolStats(pool).epoch < 2; i++) B.push(reg());
    expect(_poolStats(pool)).toMatchObject({ epoch: 2, sweeping: 0 });
    A = null;
    expect(await collectUntil(() => pool.size() === B.length)).toBe(true);
    const before = _poolStats(pool).slots;
    for (let i = 0; i < 40_000; i++) B.push(reg());
    const after = _poolStats(pool);
    expect(after.epoch).toBe(2); // nothing could prove a collection…
    expect(after.slots).toBeLessThan(before); // …and the dead are going anyway
    expect(after.slots - B.length).toBeLessThan(30_000);
  });

  it('a small pool is swept as readily as a large one', async () => {
    // Fewer entries than the window in every shard: the probes that follow a noticed
    // collection must not lap a shard and count its survivors again and again.
    for (const total of [1_000, 3_000]) {
      const pool = createInternPool<{ n: number }>();
      const held: object[] = [];
      let n = 0;
      (function registerAll() {
        for (let i = 0; i < total; i++) {
          const o = pool.register({ n }, Math.imul(++n, 0x85ebca6b) >>> 0);
          if (i % 10 === 0) held.push(o);
        }
      })();
      expect(await collectUntil(() => pool.size() === held.length)).toBe(true);
      for (let i = 0; i < total; i++) held.push(pool.register({ n }, Math.imul(++n, 0x85ebca6b) >>> 0));
      expect(_poolStats(pool)).toMatchObject({ slots: held.length, sweeping: 0 });
    }
  });

  it('notices the engine’s own collections — nothing here is forced', async () => {
    // 20k live, everything older dying, in jobs of 2,000 registrations with
    // other garbage alongside. Collections now happen when the engine chooses,
    // mostly in the middle of a job. The pool must notice some and clean up
    // after them, or it holds every entry it was ever given.
    const pool = createInternPool<{ v: number }>();
    const live = new Array<object>(20_000);
    let junk: number[][] = [];
    let registered = 0;
    while (registered < 3_000_000 && !(_poolStats(pool).epoch > 2 && _poolStats(pool).slots < registered / 2)) {
      for (let i = 0; i < 2_000; i++, registered++) {
        live[registered % live.length] = pool.register({ v: registered }, Math.imul(registered + 1, 0x85ebca6b) >>> 0);
        if ((registered & 7) === 0) junk.push(new Array<number>(16).fill(registered));
      }
      if (junk.length > 20_000) junk = [];
      await turn();
    }
    const stats = _poolStats(pool);
    expect(stats.epoch).toBeGreaterThan(2);
    expect(stats.slots).toBeLessThan(registered / 2);
  });
});

describe.skipIf(!hasGC)('InternPool — idle time (needs --expose-gc)', () => {
  beforeEach(async () => {
    // A slice asked for by an earlier test may still be pending; switched off, it does nothing when it comes.
    for (let i = 0; i < 50 && _idleState().scheduled; i++) await turn();
    _idleDriver(true);
  });
  afterEach(() => {
    _idleDriver(false);
    delete g.requestIdleCallback;
    g.setImmediate = realSetImmediate;
  });

  const registerDoomed = (pool: ReturnType<typeof createInternPool<{ v: number }>>, count: number): void => {
    for (let i = 0; i < count; i++) pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
  };

  it('a collection is answered with no registration at all: the sentinel reports it, idle turns do the rest', async () => {
    const pool = createInternPool<{ v: number }>();
    (function dropAPool() {
      registerDoomed(createInternPool<{ v: number }>(), 100); // a pool nobody keeps: its chores must not keep it
    })();
    registerDoomed(pool, 25_600);
    expect(await collectUntil(() => _poolStats(pool).slots === 0 && _poolStats(pool).migrating === 0, 40)).toBe(true);
    expect(_poolStats(pool)).toMatchObject({ slots: 0, sweeping: 0 });
    expect(_poolStats(pool).epoch).toBeGreaterThan(1);
  });

  it('idle time finishes the copies that registration began, once a collection (a scavenge will do) brings it', async () => {
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    // 300 to a shard: its copy from 512 slots to 1,024 began at 256 and moves 4 entries a registration.
    for (let i = 0; i < 19_200; i++) held.push(pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0));
    expect(_poolStats(pool).migrating).toBeGreaterThan(0);
    expect(_idleState().scheduled).toBe(false); // a registration never asks for idle time
    expect(await collectUntil(() => _poolStats(pool).migrating === 0, 40)).toBe(true);
    expect(_poolStats(pool)).toMatchObject({ slots: 19_200, migrating: 0 });
    for (let i = 0; i < held.length; i += 53) expect(pool.lookup(Math.imul(i + 1, 0x85ebca6b) >>> 0, (c) => c === held[i])).toBe(held[i]);
  });

  it('under requestIdleCallback the work is done in deadline-bounded slices', async () => {
    const callbacks: Array<(d: { timeRemaining(): number }) => void> = [];
    g.requestIdleCallback = (cb: (d: { timeRemaining(): number }) => void) => {
      callbacks.push(cb);
    };
    const pool = createInternPool<{ v: number }>();
    registerDoomed(pool, 25_600);
    expect(_idleState().scheduled).toBe(false); // registration asks for nothing
    expect(await collectUntil(() => _idleState().collected, 40)).toBe(true); // the sentinel's report does
    expect(callbacks.length).toBe(1);
    expect(_poolStats(pool).slots).toBe(25_600);

    callbacks.shift()!({ timeRemaining: () => 0 }); // no time at all: the minimum slice, and asked for again
    expect(_poolStats(pool).epoch).toBe(2);
    expect(_poolStats(pool).slots).toBeLessThan(25_600);
    expect(_poolStats(pool).slots).toBeGreaterThan(0);
    expect(callbacks.length).toBe(1);

    while (callbacks.length > 0) callbacks.shift()!({ timeRemaining: () => 50 });
    expect(_poolStats(pool)).toMatchObject({ slots: 0, sweeping: 0, migrating: 0 });
    expect(_idleState().scheduled).toBe(false);
  });

  it('a collection not worth a sweep is answered by shrinking a table found nearly empty twice running', async () => {
    // A mass death is swept in idle time; the tables it leaves are large and nearly empty,
    // and were full (of husks) when that sweep began, so they did not shrink. The next
    // collection takes little: not worth a sweep, and not yet a shrink either — a table
    // emptied by one collection may be needed again at once. The one after that shrinks
    // them: in idle time for the shards it reaches, on registration for the rest.
    const callbacks: Array<(d: { timeRemaining(): number }) => void> = [];
    g.requestIdleCallback = (cb: (d: { timeRemaining(): number }) => void) => {
      callbacks.push(cb);
    };
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    (function registerDoomed() {
      for (let i = 0; i < 200_000; i++) pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
    })();
    for (let i = 0; i < 640; i++) held.push(pool.register({ v: -i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    expect(await collectUntil(() => callbacks.length > 0, 40)).toBe(true);
    while (callbacks.length > 0) callbacks.shift()!({ timeRemaining: () => 50 });
    const swept = _poolStats(pool);
    expect(swept).toMatchObject({ slots: 640, sweeping: 0, migrating: 0 });
    expect(swept.capacity).toBeGreaterThan(400_000); // 200k in tables of 8,192 a shard, still

    (function aLittleGarbage() {
      for (let i = 0; i < 300; i++) pool.register({ v: 1e6 + i }, Math.imul(i + 1, 0x27d4eb2f) >>> 0);
    })();
    expect(await collectUntil(() => callbacks.length > 0, 40)).toBe(true);
    while (callbacks.length > 0) callbacks.shift()!({ timeRemaining: () => 50 });
    const once = _poolStats(pool);
    expect(once.epoch).toBe(swept.epoch + 1);
    expect(once).toMatchObject({ sweeping: 0, migrating: 0, capacity: swept.capacity }); // noticed; neither swept nor shrunk

    (function aLittleMoreGarbage() {
      for (let i = 0; i < 300; i++) pool.register({ v: 2e6 + i }, Math.imul(i + 1, 0x27d4eb2f) >>> 0);
    })();
    expect(await collectUntil(() => callbacks.length > 0, 40)).toBe(true);
    callbacks.shift()!({ timeRemaining: () => 0 }); // the minimum slice: a lap of one shard notices, a few shards answer
    const noticed = _poolStats(pool);
    expect(noticed.epoch).toBe(swept.epoch + 2);
    expect(noticed.migrating).toBeGreaterThan(0); // answered by shrinking…
    expect(noticed.sweeping).toBe(0); // …not by sweeping
    for (let i = 0; i < 20_000; i++) held.push(pool.register({ v: -i - 1000 }, Math.imul(i + 1, 0x165667b1) >>> 0)); // the rest answer on registration
    while (callbacks.length > 0) callbacks.shift()!({ timeRemaining: () => 50 });
    const after = _poolStats(pool);
    expect(after.capacity).toBeLessThan(swept.capacity / 2);
    expect(pool.size()).toBe(held.length);
  });

  it('on a host without FinalizationRegistry the pool is what it is everywhere: swept by its registrations', async () => {
    vi.stubGlobal('FinalizationRegistry', undefined);
    vi.resetModules();
    try {
      const host = await import('./intern-pool.js'); // a fresh copy of the module, for this host
      const pool = host.createInternPool<{ v: number }>();
      registerDoomed(pool, 25_600);
      expect(await collectUntil(() => pool.size() === 0)).toBe(true);
      for (let i = 0; i < 40; i++) await turn();
      expect(host._poolStats(pool)).toMatchObject({ slots: 25_600, epoch: 1 }); // no report, so no idle work
      const held: object[] = [];
      for (let i = 0; i < 14_000; i++) held.push(pool.register({ v: i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
      expect(host._poolStats(pool)).toMatchObject({ slots: 14_000, sweeping: 0, epoch: 2 });
      expect(held.length).toBe(14_000);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('with no scheduler, each reported collection gets one bounded slice, where it is reported', async () => {
    g.setImmediate = undefined;
    const pool = createInternPool<{ v: number }>();
    registerDoomed(pool, 25_600);
    expect(_idleState().scheduled).toBe(false);
    expect(await collectUntil(() => _poolStats(pool).slots < 25_600, 40)).toBe(true);
    expect(_poolStats(pool).slots).toBeGreaterThan(0); // one slice is not the whole job…
    expect(await collectUntil(() => _poolStats(pool).slots === 0, 60)).toBe(true); // …the next collections bring the rest
  });
});
