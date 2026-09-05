// ---------------------------------------------------------------------------
// valsem/temporal — value semantics for Temporal.
//
// Importing this module for its side effect registers, for each Temporal type:
//
//   * an equality handler   (its own `equals()`, except ZonedDateTime and
//                            Duration — see registerTemporal)
//   * a hash handler        (over the canonical `toString()`, except the two
//                            kinds whose equality is field-wise)
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
  epochNanoseconds?: bigint;
  calendarId?: string;
  timeZoneId?: string;
}

/** The ten fields of a Temporal.Duration — its value, for equality and hashing. */
const DURATION_FIELDS = [
  'years', 'months', 'weeks', 'days',
  'hours', 'minutes', 'seconds',
  'milliseconds', 'microseconds', 'nanoseconds',
] as const;

type DurationLike = Record<(typeof DURATION_FIELDS)[number], number>;

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
 * ### Duration is strictly field-wise, not `Duration.compare`
 *
 * `Temporal.Duration` is the one kind with no `equals()` method, and no total
 * equality exists for it: `Duration.compare` calls `P1D` and `PT24H` equal, and
 * *throws* on `P1M` vs `P30D` without a `relativeTo`. An equality that throws
 * cannot back a hash table, so Duration compares on its **ten fields** —
 * years through nanoseconds, each read from its accessor. That is the
 * substitutability definition of equality applied literally: two Durations
 * are equal exactly when no accessor can tell them apart.
 *
 * ```ts
 * deepEqual(Duration.from('P1D'),  Duration.from('PT24H'));   // false
 * Temporal.Duration.compare(  P1D ,           PT24H     );   // 0 — "equal"
 * deepEqual(Duration.from('PT1H'), Duration.from('PT60M'));  // false — .hours differs
 * deepEqual(Duration.from({ milliseconds: 1500 }),
 *           Duration.from({ seconds: 1, milliseconds: 500 })); // false — .milliseconds differs
 * deepEqual(Duration.from('PT0H'), Duration.from('PT0M'));   // true — all ten fields are 0
 * ```
 *
 * Deliberately NOT `toString()`: ISO 8601 has no sub-second units, so the
 * serializer folds milliseconds/microseconds/nanoseconds into decimal
 * seconds — `{ milliseconds: 1500 }` and `{ seconds: 1, milliseconds: 500 }`
 * both print `PT1.5S` while their accessors differ. An equivalence drawn
 * where a text format happens to fold is an accident, not a semantics.
 *
 * If you need `compare` semantics, normalise durations before they reach valsem
 * (e.g. `.round({ largestUnit: 'hour' })`, or `.total({ unit: 'nanoseconds' })`).
 *
 * ### ZonedDateTime: time-zone aliases are distinct values
 *
 * `ZonedDateTime.prototype.equals` is alias-tolerant: it compares time zones
 * by their primary IANA identifier, so `[Asia/Calcutta]` equals
 * `[Asia/Kolkata]`. But Temporal preserves the identifier AS SUPPLIED —
 * `.timeZoneId`, `toString()` and `toJSON()` all differ — so by the same
 * substitutability standard they are distinct values, and valsem compares a
 * `ZonedDateTime` on three accessors: `epochNanoseconds`, `timeZoneId`,
 * `calendarId`. (Case and offset spelling ARE canonicalised at construction
 * — `asia/kolkata` → `Asia/Kolkata`, `+0530` → `+05:30` — so link names are
 * the only residual non-canonical dimension.) A second reason to prefer the
 * strict answer: which identifiers are aliases depends on the runtime's tz
 * link table (`Europe/Kiev` became a link to `Europe/Kyiv` in 2022), and an
 * equality that varies by environment cannot back canonical instances.
 *
 * ```ts
 * const a = ZonedDateTime.from('2020-06-01T12:00[Asia/Calcutta]');
 * const b = ZonedDateTime.from('2020-06-01T12:00[Asia/Kolkata]');
 * a.equals(b);       // true
 * deepEqual(a, b);   // false — .timeZoneId differs
 * ```
 *
 * To merge aliases, normalise before valsem sees them:
 * `zdt.withTimeZone(canonicalId)`.
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
    const hashFn = buildHash(kind);

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
 * Hash for one Temporal kind — over exactly what its `equals()` compares.
 *
 * For the kinds that use Temporal's own `equals()`, `toString()` is a
 * faithful canonical form: calendars are canonicalised at construction, and
 * the fields `equals()` reads are the fields that print. (One known, harmless
 * looseness: a `PlainYearMonth`/`PlainMonthDay` built through the RAW
 * constructor with a non-canonical reference day/year is unequal to the
 * canonical one — `equals()` and `compare()` see the reference field — yet
 * prints the same. That is a hash collision, not a split: the pool's
 * predicate is `equals()`, so they still get distinct canonicals.)
 *
 * The two kinds with field-wise equality hash the same fields the equality
 * reads, so the hash is exactly as fine as the equality:
 *
 * - `ZonedDateTime`: `epochNanoseconds`, `timeZoneId`, `calendarId`.
 * - `Duration`: its ten fields (`toString()` would be coarser — it folds
 *   sub-second units).
 */
function buildHash(kind: Kind): (value: TemporalValue) => number {
  if (kind === 'ZonedDateTime') {
    return (value) =>
      hashString(
        `Temporal.ZonedDateTime|${value.epochNanoseconds}|${value.timeZoneId}|${value.calendarId}`,
      );
  }
  if (kind === 'Duration') {
    return (value) => {
      const d = value as unknown as DurationLike;
      let s = 'Temporal.Duration';
      for (const f of DURATION_FIELDS) s += '|' + d[f];
      return hashString(s);
    };
  }
  return (value) => hashString(`Temporal.${kind}|${value.toString()}`);
}

/**
 * Equality for one Temporal kind — accessor-distinguishability, per kind:
 *
 * - `Duration` has no `equals()`; it compares on its ten fields. (They are
 *   never `-0`: Temporal normalises it at construction, so `===` is right.)
 * - `ZonedDateTime`'s `equals()` is alias-tolerant on time zones, which is
 *   looser than its accessors; it compares on the three accessors instead.
 * - Every other kind's `equals()` IS accessor-distinguishability, and is used.
 *
 * See {@link registerTemporal} for the reasoning.
 */
function buildEquals(kind: Kind, ctor: TemporalCtor): (a: TemporalValue, b: TemporalValue) => boolean {
  if (kind === 'ZonedDateTime') {
    return (a, b) =>
      a.epochNanoseconds === b.epochNanoseconds &&
      a.timeZoneId === b.timeZoneId &&
      a.calendarId === b.calendarId;
  }
  if (kind === 'Duration') {
    return (a, b) => {
      const x = a as unknown as DurationLike;
      const y = b as unknown as DurationLike;
      for (const f of DURATION_FIELDS) if (x[f] !== y[f]) return false;
      return true;
    };
  }
  if (typeof ctor.prototype.equals !== 'function') {
    // Every other kind ships equals(); a runtime where one does not is not
    // a Temporal we know how to give value semantics to.
    throw new Error(`valsem/temporal: Temporal.${kind}.prototype.equals is missing`);
  }
  return (a, b) => a.equals!(b);
}

registerTemporal();
