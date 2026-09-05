// ---------------------------------------------------------------------------
// InternedString — opaque interned-string wrapper with cached [hashCode]
//
// JS strings already have value identity (`===`), but every fresh hash
// computation walks the string. `InternedString` precomputes the hash
// once at construction; downstream `[hashCode]` reads are O(1).
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { hashString } from './hasher.js';

const pool = createInternPool<InternedString>();

/**
 * Opaque interned-string wrapper carrying a precomputed hash.
 *
 * Two `InternedString` instances with `value === value` are the same
 * object reference. The {@link value} is the canonical JavaScript
 * string (always primitive-equal to the constructor argument).
 */
export class InternedString {
  /** The canonical JavaScript string (primitive-equal to the constructor input). */
  readonly value: string;
  readonly [hashCodeSym]: number;
  readonly [internedSym]: true = true;

  private constructor(value: string, hash: number) {
    this.value = value;
    this[hashCodeSym] = hash;
    Object.freeze(this);
  }

  /** Return the underlying {@link value}. */
  toString(): string {
    return this.value;
  }

  [equalsSym](other: unknown): boolean {
    return other instanceof InternedString && this.value === other.value;
  }

  /** Canonical InternedString for `value`. */
  static for(value: string): InternedString {
    if (typeof value !== 'string') {
      throw new TypeError(`InternedString.for: expected a string, got ${typeof value}`);
    }
    const hash = hashString(value);
    const found = pool.lookup(hash, c => c.value === value);
    if (found !== undefined) return found;
    return pool.register(new InternedString(value, hash), hash);
  }

  /** @internal Pool size — exposed for tests. */
  static _poolSize(): number {
    return pool.size();
  }
}

