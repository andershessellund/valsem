// ---------------------------------------------------------------------------
// A deterministic rng and the shuffles built on it.
//
// This file imports NOTHING from valsem, and must stay that way: the
// collision suites install a degenerate hasher before any collection loads,
// so whatever they import statically must not load one. (The arbitraries in
// property.test-helpers.ts do, which is why these are not in there.)
// ---------------------------------------------------------------------------

/** mulberry32: a seeded generator of doubles in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, IN PLACE; returns `items`. */
export function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** A shuffled COPY of `items`, the same one for the same seed. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  return shuffle(items.slice(), mulberry32(seed));
}
