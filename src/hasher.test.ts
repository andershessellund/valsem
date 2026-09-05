// hasher — the seed, the Marvin32 default, and its number path.
import { describe, it, expect } from 'vitest';
import { createMarvin32Hasher, getHashSeed } from './hasher.js';

describe('getHashSeed', () => {
  it('returns four 32-bit words, as a fresh copy each time', () => {
    const a = getHashSeed();
    const b = getHashSeed();
    expect(a).toBeInstanceOf(Uint32Array);
    expect(a.length).toBe(4);
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
    a[0] = a[0]! ^ 0xffffffff; // mutating the copy…
    expect([...getHashSeed()]).toEqual([...b]); // …does not touch the process seed
  });

  it('is the seed shared on globalThis', () => {
    const shared = (globalThis as unknown as Record<symbol, Uint32Array>)[
      Symbol.for('valsem.hashSeed.v1')
    ];
    expect([...shared!]).toEqual([...getHashSeed()]);
  });
});

describe('createMarvin32Hasher', () => {
  const h = createMarvin32Hasher(0x12345678, 0x9abcdef0);

  it('is deterministic for a key and returns uint32', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'héllo wörld', ' ', '\u{1F600}']) {
      const v = h.string(s);
      expect(v).toBe(h.string(s));
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
    }
    for (const n of [0, 1, -1, 0.5, 1e300, -1e-300, NaN, Infinity, -Infinity, 2 ** 53]) {
      const v = h.number(n);
      expect(v).toBe(h.number(n));
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
    }
  });

  it('treats -0 as +0 (the companion invariant needs it)', () => {
    expect(h.number(-0)).toBe(h.number(0));
  });

  it('distinguishes the empty string from a NUL and odd from even lengths', () => {
    expect(h.string('')).not.toBe(h.string('\0'));
    expect(h.string('a')).not.toBe(h.string('a\0'));
    expect(h.string('ab')).not.toBe(h.string('ba'));
  });

  it('differs across keys', () => {
    const other = createMarvin32Hasher(0x0badf00d, 0x0badf00d);
    let same = 0;
    for (const s of ['a', 'b', 'c', 'hello', 'world']) if (other.string(s) === h.string(s)) same++;
    expect(same).toBeLessThan(2);
    expect(other.number(42)).not.toBe(h.number(42));
  });
});
