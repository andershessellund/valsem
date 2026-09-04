// ---------------------------------------------------------------------------
// ValueList — persistent (immutable) array with incremental hashing
//
// Mutator methods (`push`, `pop`, `set`) compute the new hash from the
// existing hash in O(1) (modulo a one-off power-of-p computation for
// `set` at arbitrary indices), look up the canonical instance in the
// per-class pool, and **skip allocation entirely on a hit**.
//
// Hash scheme: polynomial accumulator
//
//     h([]) = TAG_INTERN_ARRAY
//     h([a₀, a₁, …, a_{n-1}]) = TAG_INTERN_ARRAY + Σᵢ hash(aᵢ) · pⁱ  (mod 2³²)
//
// where p = 0x9E3779B1 (odd, golden-ratio derived).  Multiplication is
// 32-bit via `Math.imul`.  Because p is odd, p has a multiplicative
// inverse mod 2³² (computed once at module load), enabling O(1) `pop`.
// ---------------------------------------------------------------------------

import { deepHash } from './deep-hash.js';
import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';

const P = 0x9e3779b1 | 0;            // odd; signed-32 representation
const P_INV = inverseMod32(P);

/** Modular inverse of an odd integer modulo 2³². */
function inverseMod32(a: number): number {
  // Newton iteration: x ← x · (2 − a·x); five iterations suffice for 32 bits.
  let x = 1;
  for (let i = 0; i < 5; i++) {
    x = Math.imul(x, 2 - Math.imul(a, x));
  }
  return x >>> 0;
}

/** p^n mod 2³² via square-and-multiply. */
function powP(n: number): number {
  let result = 1;
  let base = P;
  let e = n >>> 0;
  while (e > 0) {
    if (e & 1) result = Math.imul(result, base);
    base = Math.imul(base, base);
    e >>>= 1;
  }
  return result >>> 0;
}

const pool = createInternPool<ValueList<unknown>>();

/**
 * Persistent (immutable) array with structural identity.
 *
 * Two `ValueList` instances with element-wise `===` contents are the
 * same object reference. The underlying frozen array is exposed as
 * {@link array}. Mutator methods (`push`, `pop`, `set`) return a
 * canonical ValueList reusing the pool whenever possible.
 */
export class ValueList<T> {
  /** Frozen underlying JavaScript array. Safe to read directly. */
  readonly array: readonly T[];
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;
  /** p^length mod 2³² — used for O(1) `push`/`pop`. */
  readonly #pPow: number;

  private constructor(array: readonly T[], hash: number, pPow: number) {
    this.array = array;
    this[hashCodeSym] = hash;
    this.#pPow = pPow;
    Object.freeze(this); // see ValueMap — protects `array` and the cached [hashCode]
  }

  /** Number of elements. */
  get length(): number {
    return this.array.length;
  }

  /** Iterate the elements in order. */
  [Symbol.iterator](): IterableIterator<T> {
    return this.array[Symbol.iterator]();
  }

  [equalsSym](other: unknown): boolean {
    if (!(other instanceof ValueList)) return false;
    const a = this.array;
    const b = other.array;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Append `value` at the tail. Returns the canonical successor. */
  push(value: T): ValueList<T> {
    const vh = deepHash(value);
    const newHash = (this[hashCodeSym] + Math.imul(vh, this.#pPow)) >>> 0;
    const len = this.array.length;
    const newPPow = Math.imul(this.#pPow, P) >>> 0;
    const self = this;
    const found = pool.lookup(newHash, c => {
      const ca = c.array;
      if (ca.length !== len + 1) return false;
      if (ca[len] !== value) return false;
      const sa = self.array;
      for (let i = 0; i < len; i++) if (ca[i] !== sa[i]) return false;
      return true;
    });
    if (found !== undefined) return found as ValueList<T>;
    const fresh: T[] = new Array(len + 1);
    for (let i = 0; i < len; i++) fresh[i] = this.array[i] as T;
    fresh[len] = value;
    Object.freeze(fresh);
    return pool.register(new ValueList<T>(fresh, newHash, newPPow), newHash) as ValueList<T>;
  }

  /** Remove the tail element. Returns the canonical successor. Empty `pop` returns `this`. */
  pop(): ValueList<T> {
    const len = this.array.length;
    if (len === 0) return this;
    const last = this.array[len - 1] as T;
    const vh = deepHash(last);
    const newPPow = Math.imul(this.#pPow, P_INV) >>> 0;
    const newHash = (this[hashCodeSym] - Math.imul(vh, newPPow)) >>> 0;
    const self = this;
    const found = pool.lookup(newHash, c => {
      const ca = c.array;
      if (ca.length !== len - 1) return false;
      const sa = self.array;
      for (let i = 0; i < len - 1; i++) if (ca[i] !== sa[i]) return false;
      return true;
    });
    if (found !== undefined) return found as ValueList<T>;
    const fresh: T[] = new Array(len - 1);
    for (let i = 0; i < len - 1; i++) fresh[i] = this.array[i] as T;
    Object.freeze(fresh);
    return pool.register(new ValueList<T>(fresh, newHash, newPPow), newHash) as ValueList<T>;
  }

  /** Replace the element at `index`. Returns the canonical successor. */
  set(index: number, value: T): ValueList<T> {
    const len = this.array.length;
    if (index < 0 || index >= len) throw new RangeError(`ValueList.set: index ${index} out of range [0, ${len})`);
    const old = this.array[index] as T;
    if (old === value) return this;
    const oldH = deepHash(old);
    const newH = deepHash(value);
    const piPow = powP(index);
    const delta = Math.imul(newH - oldH, piPow);
    const newHash = (this[hashCodeSym] + delta) >>> 0;
    const self = this;
    const found = pool.lookup(newHash, c => {
      const ca = c.array;
      if (ca.length !== len) return false;
      if (ca[index] !== value) return false;
      const sa = self.array;
      for (let i = 0; i < len; i++) {
        if (i === index) continue;
        if (ca[i] !== sa[i]) return false;
      }
      return true;
    });
    if (found !== undefined) return found as ValueList<T>;
    const fresh: T[] = new Array(len);
    for (let i = 0; i < len; i++) fresh[i] = this.array[i] as T;
    fresh[index] = value;
    Object.freeze(fresh);
    return pool.register(new ValueList<T>(fresh, newHash, this.#pPow), newHash) as ValueList<T>;
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty array. */
  static empty<T>(): ValueList<T> {
    return EMPTY as ValueList<T>;
  }

  /** Canonical ValueList for the given items (compared element-wise via `===`). */
  static of<T>(...items: T[]): ValueList<T> {
    return ValueList.from(items);
  }

  /** Canonical ValueList for the given iterable. */
  static from<T>(items: Iterable<T> | ArrayLike<T>): ValueList<T> {
    const arr: T[] = Array.isArray(items) ? items.slice() : Array.from(items as Iterable<T>);
    const len = arr.length;
    if (len === 0) return EMPTY as ValueList<T>;
    let hash = 0;
    let pPow = 1;
    for (let i = 0; i < len; i++) {
      hash = (hash + Math.imul(deepHash(arr[i]), pPow)) >>> 0;
      pPow = Math.imul(pPow, P) >>> 0;
    }
    const found = pool.lookup(hash, c => {
      const ca = c.array;
      if (ca.length !== len) return false;
      for (let i = 0; i < len; i++) if (ca[i] !== arr[i]) return false;
      return true;
    });
    if (found !== undefined) return found as ValueList<T>;
    Object.freeze(arr);
    return pool.register(new ValueList<T>(arr, hash, pPow), hash) as ValueList<T>;
  }

  /** @internal Pool size — exposed for tests. */
  static _poolSize(): number {
    return pool.size();
  }
}

const EMPTY: ValueList<unknown> = (() => {
  const arr: unknown[] = [];
  Object.freeze(arr);
  const inst = new (ValueList as any)(arr, 0, 1) as ValueList<unknown>;
  return pool.register(inst, 0);
})();
