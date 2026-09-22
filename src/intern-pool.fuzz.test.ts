// A randomized model check of the intern pool against a strong-reference
// model. Adapted from the independent review of the pool's rewrite (PR #67),
// where the same check ran 190M registrations and found nothing the crafted
// tests had missed — and where crafted reasoning had missed a re-entrant
// predicate, which is in the repertoire below.
//
// Every seed drives one pool through rounds of a burst (registrations in one
// job, some kept, lookups of what is kept, misses that must miss), drops, and
// collections, checking after each that everything still held is found by
// identity, that a predicate is only ever offered candidates of the exact
// hash, that the index never stores fewer entries than are held, and at the
// end that `size()` is exactly what is held. Hash modes exercise what linear
// probing and backward-shift deletion have to get right: many equal hashes,
// one home slot, clusters that wrap the end of a table, one shard, sequential
// and negative hashes. The idle driver is on for half the seeds.
//
// Deterministic (seeded); it needs real GC and skips itself without
// globalThis.gc. FUZZ_SEEDS=n runs more seeds than the default, from FUZZ_FIRST.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createInternPool, _poolStats, _idleDriver } from './intern-pool.js';

const gc = (globalThis as { gc?: () => void }).gc;
const hasGC = typeof gc === 'function';
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

const G = 0x9e3779b1;
let G_INVERSE = G;
for (let i = 0; i < 5; i++) G_INVERSE = Math.imul(G_INVERSE, 2 - Math.imul(G, G_INVERSE));
const hashWithProduct = (m: number): number => Math.imul(m, G_INVERSE) >>> 0;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODES = ['random', 'fewHashes', 'sameHome', 'edges', 'oneShard', 'sequential', 'mixed', 'signed'] as const;
type Mode = (typeof MODES)[number];

function makeHasher(mode: Mode, rand: () => number): () => number {
  const int = (n: number): number => Math.floor(rand() * n);
  const shard = int(64);
  const home = int(1 << 10);
  switch (mode) {
    case 'random':
      return () => (rand() * 2 ** 32) >>> 0;
    case 'fewHashes': {
      const hs = Array.from({ length: 1 + int(6) }, () => (rand() * 2 ** 32) >>> 0);
      return () => hs[int(hs.length)]!;
    }
    case 'sameHome': // same shard, same top-10 tag bits: one home slot until the table has > 1024 slots
      return () => hashWithProduct(((shard << 26) | (home << 16) | int(1 << 16)) >>> 0);
    case 'edges': // products near 0 and near 2^26-1 within a shard: clusters that wrap the table end
      return () => {
        const low = int(2) === 0 ? int(1 << 8) : (1 << 26) - 1 - int(1 << 8);
        const spread = int(4) === 0 ? int(1 << 26) : low;
        return hashWithProduct(((shard << 26) | spread) >>> 0);
      };
    case 'oneShard':
      return () => hashWithProduct(((shard << 26) | int(1 << 26)) >>> 0);
    case 'sequential': {
      let n = int(1000);
      return () => n++;
    }
    case 'signed': // negative and non-uint32 forms of hashes
      return () => (rand() * 2 ** 32) | 0;
    case 'mixed': {
      const hs = (['random', 'fewHashes', 'sameHome', 'edges', 'oneShard', 'sequential'] as const).map((m) => makeHasher(m, rand));
      return () => hs[int(hs.length)]!();
    }
  }
}

type Member = { h: number };
type Held = { o: Member; h: number };

async function runSeed(seed: number): Promise<{ ops: number; lookups: number }> {
  const rand = rng(seed);
  const int = (n: number): number => Math.floor(rand() * n);
  const mode = MODES[seed % MODES.length]!;
  _idleDriver(((seed / MODES.length) | 0) % 2 === 1);
  const hasher = makeHasher(mode, rand);
  const pool = createInternPool<Member>();
  let held: Held[] = [];
  const cap = mode === 'fewHashes' || mode === 'sameHome' ? 1500 : mode === 'edges' ? 4000 : 20000;
  let ops = 0;
  let lookups = 0;
  const rounds = 6 + int(6);
  const where = (what: string): string => `seed ${seed} (${mode}): ${what}; held ${held.length}, ${JSON.stringify(_poolStats(pool))}`;

  // A lookup that, now and then, registers into the pool from inside its predicate.
  const find = (e: Held, reentrant: boolean): Member | undefined => {
    let offeredWrong = 0;
    let fired = false;
    const found = pool.lookup(e.h, (c) => {
      if ((c.h | 0) !== (e.h | 0)) offeredWrong++;
      if (reentrant && !fired) {
        fired = true;
        for (let k = 0; k < 1 + int(40); k++) {
          const h = hasher();
          const o = { h };
          pool.register(o, h);
          ops++;
          if (int(2) === 0 && held.length < cap) held.push({ o, h });
        }
      }
      return c === e.o;
    });
    lookups++;
    expect(offeredWrong, where('predicate offered a candidate of another hash')).toBe(0);
    return found;
  };
  const checkAll = (what: string): void => {
    for (const e of [...held]) expect(find(e, int(50) === 0), where(what)).toBe(e.o);
  };

  for (let r = 0; r < rounds; r++) {
    (function burst() {
      const n = 1 + int(int(4) === 0 ? cap : cap / 8);
      const keepP = [0, 0.02, 0.3, 0.9, 1][int(5)]!;
      for (let k = 0; k < n; k++) {
        const h = hasher();
        const o = { h };
        pool.register(o, h);
        ops++;
        if (rand() < keepP && held.length < cap) held.push({ o, h });
        if (int(16) === 0 && held.length > 0) {
          const e = held[int(held.length)]!;
          expect(find(e, int(8) === 0), where('mid-burst')).toBe(e.o);
        }
        if (int(64) === 0) {
          const h2 = hasher();
          let bad = 0;
          const f = pool.lookup(h2, (c) => ((c.h | 0) !== (h2 | 0) ? (bad++, false) : false));
          lookups++;
          expect(f, where('a miss that did not miss')).toBeUndefined();
          expect(bad, where('a miss offered a candidate of another hash')).toBe(0);
        }
        if ((k & 1023) === 0) expect(_poolStats(pool).slots, where('fewer entries stored than held')).toBeGreaterThanOrEqual(held.length);
      }
    })();
    checkAll(`round ${r}, after the burst`);
    const dropP = [0, 0.1, 0.5, 0.95, 1][int(5)]!;
    held = held.filter(() => rand() >= dropP);
    await turn();
    if (int(3) !== 0) {
      gc!();
      await turn();
      if (int(2) === 0) {
        await turn();
        await turn();
      }
    }
    checkAll(`round ${r}, after the collection`);
    expect(_poolStats(pool).slots, where('fewer entries stored than held')).toBeGreaterThanOrEqual(held.length);
    await turn(); // (checkAll pinned everything it dereferenced)
  }
  // Everything not held must now be collectable. A forced collection does not
  // always clear a dead target's WeakRef at once on V8 with concurrent sweeping
  // (measured: one straggler, cleared five collections later, and only with
  // some earlier seeds' heap before it) — so: never fewer than held, and held
  // exactly once the engine has caught up.
  for (let k = 0; k < 24; k++) {
    await turn();
    gc!();
    await turn();
    const size = pool.size();
    expect(size, where('size() is less than what is held')).toBeGreaterThanOrEqual(held.length);
    if (size === held.length) break;
    await turn(); // (size() pinned what it dereferenced)
  }
  expect(pool.size(), where('size() is not what is held')).toBe(held.length);
  checkAll('at the end');
  return { ops, lookups };
}

describe.skipIf(!hasGC)('InternPool — randomized model check (needs --expose-gc)', () => {
  beforeAll(() => _idleDriver(true));
  afterAll(() => _idleDriver(true));

  const seeds = Number(process.env.FUZZ_SEEDS ?? 8);
  const first = Number(process.env.FUZZ_FIRST ?? 1);
  it(`holds up over ${seeds} seeds of registrations, lookups, drops and collections`, async () => {
    let ops = 0;
    let lookups = 0;
    for (let seed = first; seed < first + seeds; seed++) {
      const r = await runSeed(seed);
      ops += r.ops;
      lookups += r.lookups;
    }
    expect(ops).toBeGreaterThan(0);
    expect(lookups).toBeGreaterThan(0);
  }, 600_000);
});
