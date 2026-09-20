// The weak-pool machinery: sharded open tables, and dropping the dead by not
// moving them when a table is replaced.
//
// Placement, exact-hash matching and growth are deterministic. Reclamation
// needs real GC — a WeakRef is cleared only by a collection, and the pool
// learns of one through its canary — and those tests skip themselves when
// globalThis.gc is unavailable (vitest.config.ts passes --expose-gc to
// workers, so normally they run).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInternPool, _poolStats, _epoch } from './intern-pool.js';
import { equals, hashCode, interned } from './deep-equal.js';

const gc = (globalThis as { gc?: () => void }).gc;
const hasGC = typeof gc === 'function';
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

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

/**
 * Collect until the pools have NOTICED: the canary is looked at every 64th
 * registration (in any pool), and a collection it did not survive starts a
 * new epoch.
 */
async function nextEpoch(): Promise<void> {
  const before = _epoch();
  const scratch = createInternPool<object>();
  for (let round = 0; round < 20 && _epoch() === before; round++) {
    await turn();
    gc!();
    await turn();
    for (let i = 0; i < 64; i++) scratch.register({}, i);
  }
  expect(_epoch()).toBeGreaterThan(before);
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    // A table is replaced one entry per registration, so for much of this loop
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
  it('the dead are dropped as registration continues, and not before', async () => {
    const pool = createInternPool<{ v: number }>();
    // Register in a callee so nothing on this frame retains the values.
    (function registerDoomed() {
      for (let i = 0; i < 20_000; i++) pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
    })();
    expect(await collectUntil(() => pool.size() === 0)).toBe(true);
    expect(_poolStats(pool).slots).toBe(20_000); // cleared, and still stored: cleanup rides on registration

    await nextEpoch();
    const held: object[] = [];
    for (let i = 0; i < 8_000; i++) held.push(pool.register({ v: i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    // Every shard found itself all dead, and replaced its table without them.
    expect(_poolStats(pool).slots).toBe(8_000);
    expect(pool.size()).toBe(8_000);
    expect(held.length).toBe(8_000);
  });

  it('a collection that took less than half of a shard is ignored', async () => {
    // About 400 to a shard: past the replacement that began at 128 (one entry
    // moves per registration, so it ended at 256) and short of the next at 512.
    // A shard whose table is still draining answers a collection afterwards.
    const pool = createInternPool<{ v: number }>();
    const held: object[] = [];
    (function registerSome() {
      for (let i = 0; i < 25_600; i++) {
        const member = pool.register({ v: i }, Math.imul(i + 1, 0x85ebca6b) >>> 0);
        if (i % 6 !== 0) held.push(member); // one in six is doomed
      }
    })();
    expect(_poolStats(pool).migrating).toBe(0);
    expect(await collectUntil(() => pool.size() === 21_333)).toBe(true);
    await nextEpoch();
    for (let i = 0; i < 2_000; i++) held.push(pool.register({ v: -i }, Math.imul(i + 1, 0xc2b2ae35) >>> 0));
    // A sixth dead is not worth a lap of dereferencing the other five sixths.
    expect(_poolStats(pool)).toMatchObject({ slots: 27_600, migrating: 0 });
    expect(pool.size()).toBe(23_333);
  });

  it('survivors stay canonical across reclamation', async () => {
    const pool = createInternPool<Point>();
    const keep = pool.intern(new Point(9, 9));
    (function registerDoomed() {
      for (let i = 0; i < 5_000; i++) pool.intern(new Point(i, 1000));
    })();
    expect(await collectUntil(() => pool.size() === 1)).toBe(true);
    await nextEpoch();
    expect(pool.intern(new Point(9, 9))).toBe(keep); // found since the collection: the lap will not ask again
    const held: Point[] = [];
    for (let i = 0; i < 3_000; i++) held.push(pool.intern(new Point(i, 2000)));
    expect(pool.intern(new Point(9, 9))).toBe(keep);
    expect(pool.size()).toBe(3_001);
    expect(_poolStats(pool).slots).toBe(3_001);
  });

  it('a shard whose survivors were underestimated is finished at once, and loses nothing', async () => {
    // One shard (products below 2^26), members in slot order: 64 doomed, then
    // 400 held. The survivor sample reads 64 occupied slots from a random
    // place; from slot 0 it meets only the doomed and sizes the next table for
    // almost nothing. The 400 then fill it before the old table has drained.
    const pool = createInternPool<{ v: number }>();
    const held: { v: number }[] = [];
    (function registerInSlotOrder() {
      for (let j = 0; j < 464; j++) {
        const member = pool.register({ v: j }, hashWithProduct((j + 1) << 16));
        if (j >= 64) held.push(member);
      }
    })();
    expect(await collectUntil(() => pool.size() === 400)).toBe(true);
    await nextEpoch();

    vi.spyOn(Math, 'random').mockReturnValue(0);
    for (let k = 0; k < 300; k++) held.push(pool.register({ v: 1000 + k }, hashWithProduct(0x2000000 + k)));

    expect(_poolStats(pool).slots).toBe(700);
    expect(pool.size()).toBe(700);
    for (let j = 64; j < 464; j++) {
      expect(pool.lookup(hashWithProduct((j + 1) << 16), (c) => c.v === j)).toBe(held[j - 64]);
    }
    for (let k = 0; k < 300; k++) {
      expect(pool.lookup(hashWithProduct(0x2000000 + k), (c) => c.v === 1000 + k)).toBe(held[400 + k]);
    }
  });
});
