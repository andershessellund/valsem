// ---------------------------------------------------------------------------
// InternString — opaque interned-string wrapper with cached [hashCode]
//
// JS strings already have value identity (`===`), but every fresh hash
// computation walks the string. `InternString` precomputes the hash
// once at construction; downstream `[hashCode]` reads are O(1).
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { hashString } from './hasher.js';

const pool = createInternPool<InternString>();

/**
 * Opaque interned-string wrapper carrying a precomputed hash.
 *
 * Two `InternString` instances with `value === value` are the same
 * object reference. The {@link value} is the canonical JavaScript
 * string (always primitive-equal to the constructor argument).
 */
export class InternString {
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
    return other instanceof InternString && this.value === other.value;
  }

  /** Canonical InternString for `value`. */
  static for(value: string): InternString {
    const hash = hashString(value);
    const found = pool.lookup(hash, c => c.value === value);
    if (found !== undefined) return found;
    return pool.register(new InternString(value, hash), hash);
  }

  /** @internal Pool size — exposed for tests. */
  static _poolSize(): number {
    return pool.size();
  }
}
