// Temporal value semantics (`valsem/temporal`).
//
// Importing the module registers globally, so the import itself is the setup.
import { describe, it, expect } from 'vitest';
import './temporal.js';
import { deepEqual, deepHash, intern } from './index.js';

const T = Temporal;

describe('temporal — value semantics', () => {
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

describe('temporal — ZonedDateTime time-zone aliases (equals() canonicalises, toString() does not)', () => {
  const pairs: [string, string][] = [
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['US/Eastern', 'America/New_York'],
    ['Europe/Kiev', 'Europe/Kyiv'],
  ];

  it('holds the companion invariant across alias identifiers', () => {
    for (const [x, y] of pairs) {
      const a = T.ZonedDateTime.from(`2020-06-01T12:00[${x}]`);
      const b = T.ZonedDateTime.from(`2020-06-01T12:00[${y}]`);
      if (!a.equals(b)) continue; // runtime without alias data — nothing to test
      expect(deepEqual(a, b)).toBe(true);
      expect(deepHash(a)).toBe(deepHash(b));
    }
  });

  it('interns alias identifiers to ONE canonical, and deepEqual agrees before and after', () => {
    for (const [x, y] of pairs) {
      const a = T.ZonedDateTime.from(`2020-06-01T12:00[${x}]`);
      const b = T.ZonedDateTime.from(`2020-06-01T12:00[${y}]`);
      if (!a.equals(b)) continue;
      const ia = intern(a);
      const ib = intern(b);
      expect(ia).toBe(ib);
      expect(deepEqual(ia, ib)).toBe(true);
    }
  });

  it('still distinguishes genuinely different zones and instants', () => {
    const a = T.ZonedDateTime.from('2020-06-01T12:00[Europe/Copenhagen]');
    const b = T.ZonedDateTime.from('2020-06-01T12:00[Europe/London]'); // a different instant
    const c = T.ZonedDateTime.from('2020-06-01T12:00[UTC]');
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(a, c)).toBe(false);
    expect(intern(a)).not.toBe(intern(b));
  });
});

describe('temporal — Duration is field-wise, not Duration.compare', () => {
  it('treats P1D and PT24H as distinct even though compare() says 0', () => {
    const day = T.Duration.from('P1D');
    const hours = T.Duration.from('PT24H');
    expect(T.Duration.compare(day, hours)).toBe(0);
    expect(deepEqual(day, hours)).toBe(false);
  });

  it('agrees wherever toString() normalises', () => {
    expect(deepEqual(T.Duration.from('PT0H'), T.Duration.from('PT0M'))).toBe(true);
    expect(deepHash(T.Duration.from('PT0H'))).toBe(deepHash(T.Duration.from('PT0M')));
  });

  it('never throws where Duration.compare would', () => {
    // compare() needs a relativeTo for calendar units and throws without one.
    expect(() => T.Duration.compare(T.Duration.from('P1M'), T.Duration.from('P30D'))).toThrow();
    expect(deepEqual(T.Duration.from('P1M'), T.Duration.from('P30D'))).toBe(false);
  });
});

describe('temporal — interning', () => {
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
