// ---------------------------------------------------------------------------
// Canonical records must stay in V8 "fast properties" mode.
//
// Building a record by assigning keys one at a time into `{}` flips it into
// dictionary mode at ~20 keys. A canonical record is read, hashed and spread
// (by every produce) for the rest of its life, so that is 6× slower reads and
// 60–150× slower copies forever. The probe is a V8 native (vitest runs with
// --allow-natives-syntax, see vitest.config.ts); it self-skips elsewhere.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { intern } from './intern.js';
import { produce } from './produce.js';

let hasFastProperties: ((o: object) => boolean) | undefined;
try {
  hasFastProperties = new Function('o', 'return %HasFastProperties(o)') as (o: object) => boolean;
  hasFastProperties({});
} catch {
  hasFastProperties = undefined;
}

const wide = (n: number, v = 1): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, v]));

describe.skipIf(hasFastProperties === undefined)('canonical records keep fast properties', () => {
  it('intern() builds fast-mode records at every width', () => {
    for (const n of [5, 16, 17, 20, 50, 200, 1000]) {
      expect(hasFastProperties!(intern(wide(n, n))), `${n} keys`).toBe(true);
    }
  });

  it('…including one carrying a __proto__ key', () => {
    const rec = intern(JSON.parse('{"__proto__": {"x": 1}, "z": 2}') as object) as Record<string, unknown>;
    expect(Object.hasOwn(rec, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
    expect(hasFastProperties!(rec)).toBe(true);
  });

  it('a base carrying an own __proto__ key still copies it as an own key (the spread branch)', () => {
    const base = intern(JSON.parse('{"__proto__": {"isAdmin": true}, "id": 1}') as object) as Record<string, unknown>;
    const next = produce(base, (d) => {
      d.id = 2;
    });
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(next).toBe(intern(JSON.parse('{"id": 2, "__proto__": {"isAdmin": true}}') as object));
  });

  it('produce successors stay fast', () => {
    const base = intern(wide(300, 7));
    const next = produce(base, (d) => {
      d.k150 = 8;
      d.k301 = 9; // an added key: the sorting slow path
    });
    expect(hasFastProperties!(next)).toBe(true);
    expect(hasFastProperties!(produce(next, (d) => void (d.k1 = 0)))).toBe(true);
  });
});
