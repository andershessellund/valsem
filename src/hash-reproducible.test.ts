// ---------------------------------------------------------------------------
// A hash under a hasher with a fixed key is the same in every process.
//
// What differs between processes is the seed: the active hasher's key, and
// with it every baked-in hash, the chunking of a ValueList and the shape of
// a trie. So this suite is two copies of valsem under two seeds — the second
// copy drawn after the shared seed is removed from globalThis, which no
// program does and a test may — building the same values and hashing them
// under one key. It gets a file to itself: it reloads the module graph.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from 'vitest';

const A = await import('./index.js');
delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('valsem.hashSeed.v1')];
vi.resetModules();
const B = await import('./index.js');

type Copy = typeof A;

const K0 = 0x7e57_5eed;
const K1 = 0x0123_4567;

/** The same values, built by one copy. A long list spans several runs and levels; a wide map, several trie levels. */
function fixture(v: Copy): Record<string, unknown> {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `row-${i}`, tags: [i % 3, 'x'] }));
  return {
    record: v.intern({ a: 1, b: 'two', c: [3, null, true], d: { e: -0, f: 2n ** 70n } }),
    raw: { a: 1, b: 'two', c: [3, null, true] },
    list: v.ValueList.from(rows),
    pushed: rows.reduce((l, r) => l.pushed(r), v.ValueList.empty<unknown>()),
    map: v.ValueMap.from(rows.map((r) => [r.id, r] as const)),
    set: v.ValueSet.from(rows),
    orderedMap: v.OrderedMap.from(rows.map((r) => [r.name, r.id] as const)),
    orderedSet: v.OrderedSet.from(rows.map((r) => r.name)),
    date: v.ValueDate.from('2026-10-15T00:00:00Z'),
    string: v.InternedString.for('interned'),
    symbol: { [Symbol.for('valsem.repro')]: 1 },
    nested: v.intern({ lists: [v.ValueList.of(1, 2), v.ValueSet.from(['a'])], when: v.ValueDate.from(0) }),
  };
}

describe('two seeds, one key', () => {
  it('really are two copies under two seeds', () => {
    expect(A.ValueList).not.toBe(B.ValueList);
    expect(String(A.getHashSeed())).not.toBe(String(B.getHashSeed()));
    expect(A.deepHash('s')).not.toBe(B.deepHash('s'));
    expect(A.deepHash({ a: [1] })).not.toBe(B.deepHash({ a: [1] }));
  });

  it('every kind of value hashes the same under the key in both copies, and differently under the two seeds', () => {
    const fa = fixture(A);
    const fb = fixture(B);
    const ha = A.createMarvin32Hasher(K0, K1);
    const hb = B.createMarvin32Hasher(K0, K1);
    for (const name of Object.keys(fa)) {
      expect(A.deepHash(fa[name], ha), name).toBe(B.deepHash(fb[name], hb));
      expect(A.deepHash(fa[name]), name).not.toBe(B.deepHash(fb[name]));
    }
    expect(A.deepHash(fa, ha)).toBe(B.deepHash(fb, hb));
  });

  it('a list built by pushing and one built at once, in copies whose runs fall differently', () => {
    const fa = fixture(A);
    const fb = fixture(B);
    // The chunking follows the seed, so the two copies' trees differ in shape…
    const shape = (l: unknown): number => JSON.stringify((l as { _structure(): unknown })._structure()).length;
    expect(shape(fa['list'])).not.toBe(shape(fb['list']));
    // …and the hash under the key does not see it.
    const ha = A.createMarvin32Hasher(K0, K1);
    const hb = B.createMarvin32Hasher(K0, K1);
    expect(A.deepHash(fa['pushed'], ha)).toBe(A.deepHash(fa['list'], ha));
    expect(B.deepHash(fb['pushed'], hb)).toBe(A.deepHash(fa['list'], ha));
  });
});
