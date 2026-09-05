// Temporal value semantics (`valsem/temporal`).
//
// Importing the module registers globally, so the import itself is the setup.
// Native Temporal is a recent-Node feature: without the global the whole
// file skips (the module throws at import by design — see
// temporal-missing.test.ts), so a Node-floor CI leg stays green while the
// latest-Node leg runs these for real.
import { describe, it, expect } from 'vitest';
import { deepEqual, deepHash, intern } from './index.js';

const HAS_TEMPORAL = typeof (globalThis as { Temporal?: unknown }).Temporal !== 'undefined';
if (HAS_TEMPORAL) await import('./temporal.js');
const T = (globalThis as { Temporal?: typeof Temporal }).Temporal!;
const describeTemporal = describe.skipIf(!HAS_TEMPORAL);

describeTemporal('temporal — value semantics', () => {
  it('every kind compares structurally instead of by reference', () => {
    const pairs: [string, unknown, unknown][] = [
      ['PlainDate', T.PlainDate.from('2026-08-31'), T.PlainDate.from('2026-08-31')],
      ['PlainDateTime', T.PlainDateTime.from('2026-08-31T12:30'), T.PlainDateTime.from('2026-08-31T12:30')],
      ['PlainTime', T.PlainTime.from('12:30'), T.PlainTime.from('12:30')],
      ['PlainYearMonth', T.PlainYearMonth.from('2026-08'), T.PlainYearMonth.from('2026-08')],
      ['PlainMonthDay', T.PlainMonthDay.from('08-31'), T.PlainMonthDay.from('08-31')],
      ['Instant', T.Instant.from('2026-08-31T00:00Z'), T.Instant.from('2026-08-31T00:00:00.000Z')],
      ['ZonedDateTime', T.ZonedDateTime.from('2026-08-31T00:00[UTC]'), T.ZonedDateTime.from('2026-08-31T00:00[UTC]')],
      ['Duration', T.Duration.from('P1DT2H'), T.Duration.from('P1DT2H')],
    ];
    for (const [kind, a, b] of pairs) {
      expect(a, kind).not.toBe(b);
      expect(deepEqual(a, b), kind).toBe(true);
      expect(deepHash(a), kind).toBe(deepHash(b));
    }
  });

  it('distinguishes values that Temporal itself calls unequal', () => {
    // Same instant, different zone — Temporal's equals() is false, and the
    // canonical toString() the hash is built on differs too.
    const utc = T.ZonedDateTime.from('2026-08-31T00:00[UTC]');
    const ny = utc.withTimeZone('America/New_York');
    expect(utc.toInstant().equals(ny.toInstant())).toBe(true);
    expect(deepEqual(utc, ny)).toBe(false);

    // Same ISO fields, different calendar.
    const iso = T.PlainDate.from('2020-01-01');
    const hebrew = T.PlainDate.from({ year: 2020, month: 1, day: 1, calendar: 'hebrew' });
    expect(deepEqual(iso, hebrew)).toBe(false);

    expect(deepEqual(T.PlainDate.from('2026-08-31'), T.PlainDate.from('2026-09-01'))).toBe(false);
    expect(deepEqual(T.PlainDate.from('2026-08-31'), T.PlainTime.from('12:30'))).toBe(false);
  });

  it('holds the companion invariant across a battery of values', () => {
    const values = [
      T.PlainDate.from('2026-08-31'),
      T.PlainDate.from('2026-08-31'),
      T.PlainDate.from('1970-01-01'),
      T.PlainTime.from('12:30'),
      T.Instant.from('2026-08-31T00:00Z'),
      T.ZonedDateTime.from('2026-08-31T00:00[UTC]'),
      T.ZonedDateTime.from('2026-08-31T00:00[Europe/Copenhagen]'),
      T.Duration.from('PT1H'),
      T.Duration.from('PT60M'),
    ];
    for (const a of values) {
      for (const b of values) {
        if (deepEqual(a, b)) expect(deepHash(a)).toBe(deepHash(b));
      }
    }
  });
});

describeTemporal('temporal — ZonedDateTime is strictly field-wise: time-zone aliases are distinct values', () => {
  // equals() resolves link names to their primary identifier; the accessors
  // and toString() keep the identifier as supplied. Substitutability sides
  // with the accessors — and does not depend on the runtime's link table.
  const aliases: [string, string][] = [
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['US/Eastern', 'America/New_York'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Etc/UTC', 'UTC'],
  ];
  const at = (tz: string) => T.ZonedDateTime.from(`2020-06-01T12:00[${tz}]`);

  it('alias identifiers are distinct values even where Temporal.equals() says equal', () => {
    for (const [x, y] of aliases) {
      const a = at(x);
      const b = at(y);
      expect(a.timeZoneId).not.toBe(b.timeZoneId);
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
      expect(intern(a)).not.toBe(intern(b));
      expect(intern(a).timeZoneId).toBe(x); // each canonical keeps its own spelling
      expect(intern(b).timeZoneId).toBe(y);
    }
  });

  it('spellings Temporal canonicalises at construction are one value', () => {
    // Case and offset formatting are normalised at the door; only link names
    // are preserved as supplied.
    for (const [x, y] of [
      ['asia/kolkata', 'Asia/Kolkata'],
      ['+0530', '+05:30'],
      ['europe/copenhagen', 'Europe/Copenhagen'],
    ]) {
      const a = at(x!);
      const b = at(y!);
      expect(a.timeZoneId).toBe(b.timeZoneId);
      expect(deepEqual(a, b)).toBe(true);
      expect(deepHash(a)).toBe(deepHash(b));
      expect(intern(a)).toBe(intern(b));
    }
  });

  it('agrees with equals() wherever the identifiers already match', () => {
    const a = T.ZonedDateTime.from('2020-06-01T12:00[Europe/Copenhagen]');
    const b = T.ZonedDateTime.from('2020-06-01T10:00[UTC]').withTimeZone('Europe/Copenhagen');
    expect(a.equals(b)).toBe(true);
    expect(deepEqual(a, b)).toBe(true);
    expect(deepHash(a)).toBe(deepHash(b));
    expect(intern(a)).toBe(intern(b));
  });

  it('distinguishes zone, instant, and calendar independently', () => {
    const base = at('Europe/Copenhagen');
    const sameInstantOtherZone = base.withTimeZone('Europe/Berlin'); // same offset, same instant
    const sameWallOtherZone = at('Europe/London'); // a different instant
    const otherCalendar = base.withCalendar('gregory');
    const offsetSpelled = base.withTimeZone('+02:00'); // same instant, offset zone
    for (const other of [sameInstantOtherZone, sameWallOtherZone, otherCalendar, offsetSpelled]) {
      expect(deepEqual(base, other)).toBe(false);
      expect(intern(base)).not.toBe(intern(other));
    }
    // Europe/Copenhagen became a tzdata link to Europe/Berlin in 2024b, so on
    // such a runtime Temporal's equals() calls them EQUAL — and on an older
    // one it does not. The strict answer above is the same everywhere; that
    // environment-dependence is the second reason not to defer to equals().
    expect(typeof base.equals(sameInstantOtherZone)).toBe('boolean');
  });

  it('normalising the zone is the way to merge aliases', () => {
    const a = at('Asia/Calcutta').withTimeZone('Asia/Kolkata');
    const b = at('Asia/Kolkata');
    expect(deepEqual(a, b)).toBe(true);
    expect(intern(a)).toBe(intern(b));
  });
});

describeTemporal('temporal — Duration is strictly field-wise, not Duration.compare', () => {
  it('treats P1D and PT24H as distinct even though compare() says 0', () => {
    const day = T.Duration.from('P1D');
    const hours = T.Duration.from('PT24H');
    expect(T.Duration.compare(day, hours)).toBe(0);
    expect(deepEqual(day, hours)).toBe(false);
  });

  it('distinguishes every pair an accessor can distinguish — including where toString() folds', () => {
    const distinct: [Temporal.DurationLike | string, Temporal.DurationLike | string][] = [
      [{ milliseconds: 1500 }, { seconds: 1, milliseconds: 500 }], // both print PT1.5S
      [{ microseconds: 1000 }, { milliseconds: 1 }], // both print PT0.001S
      [{ nanoseconds: 1_500_000_000 }, { seconds: 1, milliseconds: 500 }],
      ['PT1H', 'PT60M'],
      ['PT90S', 'PT1M30S'],
      ['P1W', 'P7D'],
      ['P1D', 'PT24H'],
      ['PT1H', '-PT1H'],
    ];
    for (const [x, y] of distinct) {
      const a = T.Duration.from(x);
      const b = T.Duration.from(y);
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
      expect(intern(a)).not.toBe(intern(b));
    }
    // The first two pairs are the ones toString() cannot tell apart.
    expect(T.Duration.from({ milliseconds: 1500 }).toString()).toBe(
      T.Duration.from({ seconds: 1, milliseconds: 500 }).toString(),
    );
  });

  it('equates exactly the Durations whose ten fields agree, with equal hashes', () => {
    const equal: [Temporal.DurationLike | string, Temporal.DurationLike | string][] = [
      ['PT0H', 'PT0M'], // every field 0
      ['PT0S', { hours: 0, nanoseconds: 0 }],
      [{ hours: -0 }, { hours: 0 }], // Temporal normalises -0 at construction
      ['P1DT2H', { days: 1, hours: 2 }],
      [{ years: 1, nanoseconds: 1 }, 'P1YT0.000000001S'],
      ['-P1M', { months: -1 }],
    ];
    for (const [x, y] of equal) {
      const a = T.Duration.from(x);
      const b = T.Duration.from(y);
      expect(deepEqual(a, b)).toBe(true);
      expect(deepHash(a)).toBe(deepHash(b));
      expect(intern(a)).toBe(intern(b));
    }
  });

  it('never throws where Duration.compare would', () => {
    // compare() needs a relativeTo for calendar units and throws without one.
    expect(() => T.Duration.compare(T.Duration.from('P1M'), T.Duration.from('P30D'))).toThrow();
    expect(deepEqual(T.Duration.from('P1M'), T.Duration.from('P30D'))).toBe(false);
  });
});

describeTemporal('temporal — interning', () => {
  it('pools Temporal values as canonical instances', () => {
    const a = T.PlainDate.from('2026-08-31');
    const b = T.PlainDate.from('2026-08-31');
    expect(a).not.toBe(b);
    expect(intern(a)).toBe(intern(b));
  });

  it('does not freeze them (they are immutable by contract, not by freeze)', () => {
    expect(Object.isFrozen(intern(T.PlainTime.from('12:30')))).toBe(false);
  });

  it('interns records containing Temporal values to one canonical object', () => {
    const one = intern({ when: T.PlainDate.from('2026-08-31'), n: 1 });
    const two = intern({ n: 1, when: T.PlainDate.from('2026-08-31') });
    expect(one).toBe(two);
  });

  it('rejects the mutable built-ins rather than pooling or ignoring them', () => {
    // Passing them through silently would let HashMap key by reference and miss
    // every structurally equal lookup — a silent wrong answer.
    expect(() => intern(new Date(0))).toThrow(/Temporal\.Instant/);
    expect(() => intern(/a/g)).toThrow(/source, flags/);
    expect(() => intern(new Map())).toThrow(/ValueMap\.from/);
    expect(() => intern(new Set())).toThrow(/ValueSet\.from/);
    // Top-level and nested fail the same way.
    expect(() => intern({ at: new Date(0) })).toThrow(/Temporal\.Instant/);
  });
});
