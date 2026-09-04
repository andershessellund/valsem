// ---------------------------------------------------------------------------
// hasher — pluggable, seeded leaf hashing
//
// deepHash and interning route every string/number *leaf* through the active
// Hasher; the structural combiners (mix/scramble, the collection polynomials)
// stay fixed. The default is a per-process SEEDED hash: Marvin32 over UTF-16
// code-unit pairs for strings (the algorithm .NET ships for DoS-resistant
// string hashing) plus a seeded avalanche for numbers (as V8 does for integer
// keys). Because the seed is a secret drawn once per process, an attacker
// cannot precompute inputs that collide into the same bucket — closing the
// hash-flooding vector — while honest workloads pay ~1.0-1.4x FNV.
//
// The seed lives on `globalThis` so duplicate installs in one process agree.
// For deployments that ingest untrusted data and worry about seed recovery via
// timing, `configureHasher` swaps in a stronger keyed PRF (e.g. SipHash) built
// over `getHashSeed()`.
// ---------------------------------------------------------------------------

/**
 * A pluggable pair of seeded leaf-hash primitives (string / number → uint32).
 *
 * Implementations MUST be seeded (so collisions are not offline-predictable)
 * and MUST treat `-0` as `+0` so the companion invariant
 * `deepEqual(a, b) ⟹ deepHash(a) === deepHash(b)` holds.
 */
export interface Hasher {
  /** Hash a string to a 32-bit value. */
  readonly string: (s: string) => number;
  /** Hash a JS number to a 32-bit value (`-0` treated as `+0`). */
  readonly number: (n: number) => number;
}

// ---------------------------------------------------------------------------
// Process seed (128-bit), shared across duplicate installs via globalThis.
// ---------------------------------------------------------------------------

const SEED_KEY = Symbol.for('valsem.hashSeed.v1');

function readSeed(): Uint32Array {
  const g = globalThis as unknown as Record<symbol, Uint32Array | undefined>;
  const existing = g[SEED_KEY];
  if (existing !== undefined) return existing;
  // Structural type instead of the DOM `Crypto` name: valsem is runtime-
  // neutral and does not compile against the DOM lib.
  const c = (globalThis as {
    crypto?: { getRandomValues?: <T extends ArrayBufferView>(array: T) => T };
  }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error(
      'valsem: globalThis.crypto.getRandomValues is required to seed the hasher. ' +
        'Provide a Web Crypto implementation (Node \u2265 15, all Workers/browsers), ' +
        'or call configureHasher() with a hasher carrying an explicit key.',
    );
  }
  const seed = c.getRandomValues(new Uint32Array(4));
  g[SEED_KEY] = seed;
  return seed;
}

const SEED = readSeed();

/**
 * The process hash seed (four 32-bit words). Reuse it when building a custom
 * {@link Hasher} (e.g. a SipHash key) so all hashers in the process agree.
 */
export function getHashSeed(): Uint32Array {
  return SEED.slice();
}

// ---------------------------------------------------------------------------
// Default hasher: Marvin32 (strings) + seeded avalanche (numbers).
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/**
 * Build a seeded {@link Hasher} using **Marvin32** over UTF-16 code-unit pairs
 * for strings and a seeded avalanche for numbers. This is valsem's default.
 *
 * @param k0 - Low 32 bits of the 64-bit key.
 * @param k1 - High 32 bits of the 64-bit key.
 */
export function createMarvin32Hasher(k0: number, k1: number): Hasher {
  const K0 = k0 | 0;
  const K1 = k1 | 0;

  const string = (s: string): number => {
    let p0 = K0;
    let p1 = K1;
    const n = s.length;
    let i = 0;
    // Two UTF-16 code units per 32-bit block.
    for (; i + 2 <= n; i += 2) {
      p0 = (p0 + (s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16))) | 0;
      p1 ^= p0; p0 = (p0 << 20) | (p0 >>> 12); p0 = (p0 + p1) | 0;
      p1 = (p1 << 9) | (p1 >>> 23); p1 ^= p0; p0 = (p0 << 27) | (p0 >>> 5); p0 = (p0 + p1) | 0;
      p1 = (p1 << 19) | (p1 >>> 13);
    }
    // Tail: 0 or 1 remaining code unit, plus a terminator so "" ≠ "\0" etc.
    p0 = i < n ? (p0 + (0x800000 | s.charCodeAt(i))) | 0 : (p0 + 0x80) | 0;
    // Two finalization rounds.
    for (let r = 0; r < 2; r++) {
      p1 ^= p0; p0 = (p0 << 20) | (p0 >>> 12); p0 = (p0 + p1) | 0;
      p1 = (p1 << 9) | (p1 >>> 23); p1 ^= p0; p0 = (p0 << 27) | (p0 >>> 5); p0 = (p0 + p1) | 0;
      p1 = (p1 << 19) | (p1 >>> 13);
    }
    return (p1 ^ p0) >>> 0;
  };

  const number = (nv: number): number => {
    f64[0] = nv === 0 ? 0 : nv; // normalize -0 → +0
    // Seeded murmur3-style avalanche over the 64 IEEE-754 bits.
    let h = (u32[0] ^ K0) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = (h ^ u32[1] ^ K1) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };

  return { string, number };
}

// ---------------------------------------------------------------------------
// Active hasher — leaf functions are live-binding exports for the hot path.
// ---------------------------------------------------------------------------

let configured = false;
const _default = createMarvin32Hasher(SEED[0]!, SEED[1]!);

/** @internal Active string-leaf hash. Rebound by {@link configureHasher}. */
export let hashString: (s: string) => number = _default.string;
/** @internal Active number-leaf hash. Rebound by {@link configureHasher}. */
export let hashNumber: (n: number) => number = _default.number;

/**
 * Replace the leaf hashing primitives process-wide.
 *
 * Call this **once, at startup, before any value is hashed or interned**.
 * Hashes are baked into interned values and into the incremental collections'
 * accumulators, so swapping the hasher after hashing has begun would corrupt
 * identity — hence the one-shot guard.
 *
 * Use it to plug in a stronger keyed PRF (e.g. SipHash built over
 * {@link getHashSeed}) for deployments that ingest untrusted data and want
 * resistance to seed recovery via timing.
 *
 * @throws Error if called more than once.
 *
 * @example
 * ```ts
 * import { configureHasher, getHashSeed, type Hasher } from 'valsem';
 * const key = getHashSeed();
 * const sip: Hasher = { string: (s) => sipHash(key, s), number: (n) => sipHashNum(key, n) };
 * configureHasher(sip); // before any intern()/deepHash()
 * ```
 */
export function configureHasher(hasher: Hasher): void {
  if (configured) {
    throw new Error('valsem: configureHasher() may only be called once, before any hashing.');
  }
  configured = true;
  hashString = hasher.string;
  hashNumber = hasher.number;
}
