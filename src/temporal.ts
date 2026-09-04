// ---------------------------------------------------------------------------
// valsem/temporal — value semantics for Temporal.
//
// Importing this module for its side effect registers, for each Temporal type:
//
//   * an equality handler   (its own `equals()`, except Duration — see below)
//   * a hash handler        (over the canonical `toString()`)
//   * an immutability declaration, so `intern()` pools Temporal values as
//     canonical `===` instances rather than passing them through
//
//     import 'valsem/temporal';
//
// It lives behind its own entry point so consumers who do not use Temporal pay
// nothing for it. (Serializing Temporal values is a wire binding's concern,
// one layer up; such a codec module imports this one first and builds on it.)
//
// Temporal values are safe to pool unfrozen: they expose accessors only, have
// no mutators, and (unlike Date and RegExp) cannot be re-timed or carry a
// cursor. They are deliberately NOT frozen — freezing a foreign type can break
// it, and Temporal does not need it.
// ---------------------------------------------------------------------------

import { deepEqual } from './deep-equal.js';
import { hashString } from './hasher.js';

/** The Temporal types this module knows about, in registration order. */
const KINDS = [
  'PlainDate',
  'PlainDateTime',
  'PlainTime',
  'PlainYearMonth',
  'PlainMonthDay',
  'Instant',
  'ZonedDateTime',
  'Duration',
] as const;

type Kind = (typeof KINDS)[number];

/** Structural view of a Temporal value — the surface this module relies on. */
interface TemporalValue {
  toString(): string;
  equals?(other: unknown): boolean;
}

/** Structural view of a Temporal constructor. */
interface TemporalCtor extends Function {
  from(source: string): TemporalValue;
  prototype: TemporalValue;
}

let registered = false;

/**
 * Register value semantics for every Temporal type the runtime provides. Called automatically when this module is imported; exported so
 * tests and applications can re-run it explicitly. Idempotent.
 *
 * ### Duration is field-wise, not `Duration.compare`
 *
 * `Temporal.Duration` is the one kind with no `equals()` method, and no total
 * equality exists for it: `Duration.compare` calls `P1D` and `PT24H` equal, and
 * *throws* on `P1M` vs `P30D` without a `relativeTo`. An equality that throws
 * cannot back a hash table, so Duration compares **field-wise** on its
 * canonical `toString()`:
 *
 * ```ts
 * deepEqual(Duration.from('P1D'), Duration.from('PT24H'));  // false
 * Temporal.Duration.compare(  P1D ,          PT24H      );  // 0 — "equal"
 * deepEqual(Duration.from('PT0H'), Duration.from('PT0M')); // true — both PT0S
 * ```
 *
 * If you need `compare` semantics, normalise durations before they reach valsem
 * (e.g. `.total({ unit: 'nanoseconds' })`).
 *
 * @throws Error if the runtime provides no `Temporal` global.
 */
export function registerTemporal(): void {
  if (registered) return;

  const T = (globalThis as { Temporal?: Record<string, unknown> }).Temporal;
  if (T === undefined) {
    throw new Error(
      "valsem/temporal: no Temporal global found. Use a runtime with native " +
        'Temporal, or install a polyfill before importing this module.',
    );
  }

  for (const kind of KINDS) {
    const ctor = T[kind] as TemporalCtor | undefined;
    if (typeof ctor !== 'function' || typeof ctor.from !== 'function') continue;

    const equalsFn = buildEquals(kind, ctor);
    const hashFn = (value: TemporalValue): number =>
      hashString(`Temporal.${kind}|${value.toString()}`);

    deepEqual.register(
      ctor as unknown as new (...args: any[]) => TemporalValue,
      equalsFn,
      hashFn,
      { immutable: true },
    );
  }

  registered = true;
}

/**
 * Equality for one Temporal kind. Every kind but `Duration` ships an `equals()`
 * that is authoritative and agrees with `toString()` — including the cases
 * worth worrying about, where a differing time zone or a non-ISO calendar shows
 * up in the string. `Duration` has no `equals()`; see {@link registerTemporal}.
 */
function buildEquals(kind: Kind, ctor: TemporalCtor): (a: TemporalValue, b: TemporalValue) => boolean {
  if (kind !== 'Duration' && typeof ctor.prototype.equals === 'function') {
    return (a, b) => a.equals!(b);
  }
  return (a, b) => a.toString() === b.toString();
}

registerTemporal();
