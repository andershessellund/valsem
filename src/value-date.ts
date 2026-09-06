// ---------------------------------------------------------------------------
// ValueDate — an immutable, canonical timestamp.
//
// `Date` is not a value: it can be re-timed with setTime(), so valsem rejects
// it. What a Date *means* is one number — epoch milliseconds — and that is
// all a ValueDate holds. Instances are canonical by construction (private
// constructor + pool), so `ValueDate.of(t) === ValueDate.of(t)`, they pass
// through `intern`/`produce` untouched, and they key a HashMap/ValueMap in
// O(1).
//
// It matches Date where Date has a convention: `of(x)` accepts exactly what
// `new Date(x)` accepts (and parses it the same way), `valueOf()` is the
// epoch so `<` / `>` / subtraction work, and `toJSON()` is the ISO string so
// a state holding ValueDates stringifies exactly as one holding Dates.
// `toDate()` hands out a fresh mutable Date each call — the value itself
// never changes.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { hashNumber } from './hasher.js';

const pool = createInternPool<ValueDate>();

/** Ordered hash combine — boost-style. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

/**
 * An immutable, canonical timestamp — the value a `Date` stands for.
 *
 * `ValueDate.of(x)` accepts whatever `new Date(x)` accepts (a `Date`, an
 * ISO or date string, epoch milliseconds) and parses it by the same rules,
 * so `'2026-09-05'` is UTC midnight and `'2026-09-05T00:00'` is local, just
 * as with `Date`. An invalid date is rejected rather than admitted as a
 * value. Equal instants are the same instance: `ValueDate.of(t) === ValueDate.of(t)`.
 *
 * ```ts
 * const at = ValueDate.of('2026-09-05T10:00:00Z');
 * at.epochMs;             // 1788602400000
 * at.toDate();            // a fresh, mutable Date — change it freely
 * at < ValueDate.of(Date.now()); // valueOf() is the epoch, so comparisons work
 * JSON.stringify({ at }); // {"at":"2026-09-05T10:00:00.000Z"} — same as with a Date
 * ```
 */
export class ValueDate {
  /** Milliseconds since the Unix epoch — the whole value. */
  readonly epochMs: number;
  readonly #hash: number;

  private constructor(epochMs: number) {
    this.epochMs = epochMs;
    this.#hash = mix(0xda7e, hashNumber(epochMs));
    Object.freeze(this);
  }

  /** Cached structural hash — the `[hashCode]` protocol, served from a private field so no own symbol property exists (spread cannot copy the markers). */
  get [hashCodeSym](): number {
    return this.#hash;
  }
  /** The canonical-type marker: every instance is canonical by construction. */
  get [internedSym](): true {
    return true;
  }

  /**
   * The canonical ValueDate for `x` — a `Date`, a string, epoch milliseconds,
   * or a ValueDate (returned as-is). Parsed exactly as `new Date(x)` would be.
   *
   * @throws RangeError if `x` is not a valid date.
   */
  static of(x: ValueDate | Date | string | number): ValueDate {
    if (x instanceof ValueDate) return x;
    const ms = x instanceof Date ? x.getTime() : new Date(x).getTime();
    if (ms !== ms) {
      throw new RangeError(
        `ValueDate.of: ${typeof x === 'string' ? JSON.stringify(x) : String(x)} is not a valid date`,
      );
    }
    const normalized = ms === 0 ? 0 : ms; // -0 → +0: one instant, one instance
    const hash = mix(0xda7e, hashNumber(normalized));
    const found = pool.lookup(hash, (c) => c.epochMs === normalized);
    if (found !== undefined) return found;
    return pool.register(new ValueDate(normalized), hash);
  }

  /** A fresh, mutable `Date` for this instant. Mutating it does not touch the value. */
  toDate(): Date {
    return new Date(this.epochMs);
  }

  /** The instant in ISO 8601, UTC — what `Date.prototype.toISOString` gives. */
  toISOString(): string {
    return new Date(this.epochMs).toISOString();
  }

  /** ISO 8601, as `Date` does — `JSON.stringify` output is identical to a `Date`'s. */
  toJSON(): string {
    return this.toISOString();
  }

  /** Epoch milliseconds, so `<`, `>`, and subtraction work as with `Date`. */
  valueOf(): number {
    return this.epochMs;
  }

  toString(): string {
    return this.toISOString();
  }

  [equalsSym](other: unknown): boolean {
    return other instanceof ValueDate && other.epochMs === this.epochMs;
  }
}
