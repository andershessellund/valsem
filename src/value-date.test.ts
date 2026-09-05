import { describe, expect, it } from 'vitest';
import { ValueDate } from './value-date.js';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { produce } from './produce.js';
import { HashMap } from './hash-map.js';
import { ValueMap } from './value-map.js';

const T = 1_788_602_400_000; // 2026-09-05T10:00:00Z

describe('ValueDate.of', () => {
  it('accepts what `new Date(x)` accepts, and parses it the same way', () => {
    const inputs: (Date | string | number)[] = [
      new Date(T),
      T,
      '2026-09-05T10:00:00Z',
      '2026-09-05T10:00:00.000Z',
      '2026-09-05T12:00:00+02:00',
    ];
    for (const x of inputs) expect(ValueDate.of(x).epochMs).toBe(T);
    // Date's own rules, verbatim — date-only strings are UTC, date-time strings are local.
    expect(ValueDate.of('2026-09-05').epochMs).toBe(new Date('2026-09-05').getTime());
    expect(ValueDate.of('2026-09-05T00:00').epochMs).toBe(new Date('2026-09-05T00:00').getTime());
    expect(ValueDate.of('March 7, 2021').epochMs).toBe(new Date('March 7, 2021').getTime());
  });

  it('returns a ValueDate unchanged', () => {
    const d = ValueDate.of(T);
    expect(ValueDate.of(d)).toBe(d);
  });

  it('is canonical: one instant, one instance, however it was spelled', () => {
    const a = ValueDate.of(T);
    expect(ValueDate.of(new Date(T))).toBe(a);
    expect(ValueDate.of('2026-09-05T10:00:00Z')).toBe(a);
    expect(ValueDate.of('2026-09-05T12:00:00+02:00')).toBe(a);
    expect(ValueDate.of(T + 1)).not.toBe(a);
    expect(ValueDate.of(-0)).toBe(ValueDate.of(0)); // one epoch, not two
  });

  it('rejects invalid dates instead of admitting NaN as a value', () => {
    expect(() => ValueDate.of('not a date')).toThrow(/"not a date" is not a valid date/);
    expect(() => ValueDate.of(NaN)).toThrow(/not a valid date/);
    expect(() => ValueDate.of(new Date('garbage'))).toThrow(/not a valid date/);
    expect(() => ValueDate.of(8.64e15 + 1)).toThrow(/not a valid date/); // beyond Date's range
  });

  it('is frozen and marked canonical', () => {
    const d = ValueDate.of(T);
    expect(Object.isFrozen(d)).toBe(true);
    expect(d[interned]).toBe(true);
    expect(typeof d[hashCode]).toBe('number');
  });
});

describe('ValueDate — Date parity', () => {
  it('toDate() is a fresh, mutable Date each call; mutating it changes nothing', () => {
    const d = ValueDate.of(T);
    const a = d.toDate();
    const b = d.toDate();
    expect(a).not.toBe(b);
    expect(a.getTime()).toBe(T);
    a.setTime(0);
    expect(d.epochMs).toBe(T);
    expect(d.toDate().getTime()).toBe(T);
    expect(ValueDate.of(T)).toBe(d);
  });

  it('toISOString/toJSON/toString are the ISO string, and JSON output matches a Date', () => {
    const d = ValueDate.of(T);
    expect(d.toISOString()).toBe('2026-09-05T10:00:00.000Z');
    expect(d.toJSON()).toBe(d.toISOString());
    expect(String(d)).toBe(d.toISOString());
    expect(JSON.stringify({ at: d })).toBe(JSON.stringify({ at: new Date(T) }));
    // …and the way back is the same step it is for Date.
    expect(ValueDate.of(JSON.parse(JSON.stringify({ at: d })).at)).toBe(d);
  });

  it('valueOf() is the epoch, so comparisons and arithmetic work as with Date', () => {
    const a = ValueDate.of(T);
    const b = ValueDate.of(T + 1000);
    expect(a < b).toBe(true);
    expect(b > a).toBe(true);
    expect(+b - +a).toBe(1000);
    expect(Math.max(+a, +b)).toBe(T + 1000);
    expect([b, a].sort((x, y) => +x - +y)[0]).toBe(a);
  });
});

describe('ValueDate — a value', () => {
  it('deepEqual, deepHash and intern treat it as the canonical value it is', () => {
    const a = ValueDate.of(T);
    const b = ValueDate.of(new Date(T));
    expect(deepEqual(a, b)).toBe(true);
    expect(deepHash(a)).toBe(deepHash(b));
    expect(intern(a)).toBe(a);
    expect(a[equals](b)).toBe(true);
    expect(a[equals](new Date(T))).toBe(false);
    expect(deepEqual(a, ValueDate.of(T + 1))).toBe(false);
  });

  it('lives inside records, produce, and collections without ceremony', () => {
    const state = intern({ createdAt: ValueDate.of(T), title: 'x' });
    expect(intern({ title: 'x', createdAt: ValueDate.of(new Date(T)) })).toBe(state);

    const next = produce(state, (d) => {
      d.createdAt = ValueDate.of(T + 60_000);
    });
    expect(next.createdAt).toBe(ValueDate.of(T + 60_000));
    expect(produce(next, (d) => void (d.createdAt = ValueDate.of(T + 60_000)))).toBe(next);

    const m = new HashMap<ValueDate, string>();
    m.set(ValueDate.of(T), 'v');
    expect(m.get(ValueDate.of('2026-09-05T10:00:00Z'))).toBe('v');

    const vm = ValueMap.from([[ValueDate.of(T), 1]]);
    expect(vm.get(ValueDate.of(new Date(T)))).toBe(1);
    expect(ValueMap.from([[ValueDate.of(T), 1]])).toBe(vm);
  });

  it('is what the Date rejection now points at', () => {
    expect(() => intern({ at: new Date(T) })).toThrow(/ValueDate\.of\(date\)/);
    expect(() => deepHash(new Date(T))).toThrow(/ValueDate\.of\(date\)/);
  });
});
