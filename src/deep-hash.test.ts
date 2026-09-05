// ---------------------------------------------------------------------------
// deepHash — tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { deepHash } from './deep-hash.js';
import { deepEqual, equals, hashCode } from './deep-equal.js';

describe('deepHash', () => {
  // --- Consistency with deepEqual ---

  it('equal values produce equal hashes', () => {
    const pairs: [unknown, unknown][] = [
      [1, 1],
      ['hello', 'hello'],
      [true, true],
      [null, null],
      [undefined, undefined],
      [NaN, NaN],
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      [{ a: undefined }, {}],
      [{ a: undefined, b: 1 }, { b: 1 }],
      [[1, 2, 3], [1, 2, 3]],
      [{ nested: { a: [1, 2] } }, { nested: { a: [1, 2] } }],
    ];

    for (const [a, b] of pairs) {
      expect(deepEqual(a, b), `deepEqual(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(true);
      expect(deepHash(a), `hash(${JSON.stringify(a)}) === hash(${JSON.stringify(b)})`).toBe(
        deepHash(b),
      );
    }
  });

  it('different values produce different hashes (probabilistic)', () => {
    const values: unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      1,
      -1,
      42,
      NaN,
      '',
      'a',
      'b',
      'hello',
      [],
      [1],
      [1, 2],
      [2, 1],
      {},
      { a: 1 },
      { b: 1 },
      { a: 2 },
      { a: 1, b: 2 },
      { a: 2, b: 1 },
      [1, 2, 3],
      [3, 2, 1],
      { a: [1] },
      { a: [2] },
      [[1]],
      [[2]],
    ];

    const hashes = values.map((v) => deepHash(v));
    const unique = new Set(hashes);
    // With a good 32-bit hash, all 29 values should produce unique hashes
    expect(unique.size).toBe(values.length);
  });

  // --- Primitives ---

  it('returns a number for all supported types', () => {
    expect(typeof deepHash(null)).toBe('number');
    expect(typeof deepHash(undefined)).toBe('number');
    expect(typeof deepHash(true)).toBe('number');
    expect(typeof deepHash(42)).toBe('number');
    expect(typeof deepHash('hello')).toBe('number');
    expect(typeof deepHash(42n)).toBe('number');
  });

  it('+0 and -0 hash equally', () => {
    // deepEqual(+0, -0) is true (uses ===), so hashes must match
    expect(deepHash(+0)).toBe(deepHash(-0));
  });

  // --- Objects ---

  it('object key order does not affect hash', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, x: 1, y: 2 };
    expect(deepHash(a)).toBe(deepHash(b));
  });

  it('deeply nested objects with different key order', () => {
    const a = { outer: { a: 1, b: 2 }, list: [{ x: 10, y: 20 }] };
    const b = { list: [{ y: 20, x: 10 }], outer: { b: 2, a: 1 } };
    expect(deepHash(a)).toBe(deepHash(b));
  });

  // --- Mutable built-ins are rejected, with the replacement named ---

  it('rejects Date, RegExp, Map, Set, and the TypedArray family', () => {
    expect(() => deepHash(new Date(0))).toThrow(TypeError);
    expect(() => deepHash(/a/g)).toThrow(TypeError);
    expect(() => deepHash(new Map([['a', 1]]))).toThrow(TypeError);
    expect(() => deepHash(new Set([1]))).toThrow(TypeError);
    expect(() => deepHash(new Uint8Array([1]))).toThrow(TypeError);
    expect(() => deepHash(new Float64Array([1]))).toThrow(TypeError);
    expect(() => deepHash(new DataView(new ArrayBuffer(4)))).toThrow(TypeError);
    expect(() => deepHash(new ArrayBuffer(4))).toThrow(TypeError);
  });

  it('names the immutable replacement in each error', () => {
    // deepEqual cannot throw, so this is the only place a user learns why.
    expect(() => deepHash(new Date(0))).toThrow(/Temporal\.Instant/);
    expect(() => deepHash(/a/g)).toThrow(/source, flags/);
    expect(() => deepHash(new Map())).toThrow(/ValueMap\.from/);
    expect(() => deepHash(new Set())).toThrow(/ValueSet\.from/);
    expect(() => deepHash(new Date(0))).toThrow(/immutable values only/);
    expect(() => deepHash(new Uint8Array([1]))).toThrow(/hex or base64 string/);
    expect(() => deepHash(new Uint8Array([1]))).toThrow(/any view over the same buffer/);
  });

  it('rejects them nested inside a record too', () => {
    expect(() => deepHash({ at: new Date(0) })).toThrow(/Temporal\.Instant/);
    expect(() => deepHash([new Set([1])])).toThrow(/ValueSet\.from/);
  });

  // --- Type discrimination ---

  it('different types with similar content hash differently', () => {
    // array [1] vs object {0: 1}
    expect(deepHash([1])).not.toBe(deepHash({ '0': 1 }));
    // number 1 vs string '1'
    expect(deepHash(1)).not.toBe(deepHash('1'));
    // null vs undefined
    expect(deepHash(null)).not.toBe(deepHash(undefined));
    // true vs 1
    expect(deepHash(true)).not.toBe(deepHash(1));
    // false vs 0
    expect(deepHash(false)).not.toBe(deepHash(0));
    // empty array vs empty object
    expect(deepHash([])).not.toBe(deepHash({}));
  });

  // --- Deterministic ---

  it('same value always produces same hash', () => {
    const obj = { items: [1, 2, 3], name: 'test', nested: { ok: true } };
    const h1 = deepHash(obj);
    const h2 = deepHash(obj);
    const h3 = deepHash({ name: 'test', nested: { ok: true }, items: [1, 2, 3] });
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });

  // --- Unsupported types ---

  it('throws for symbols', () => {
    expect(() => deepHash(Symbol())).toThrow('not supported');
  });

  it('throws for functions', () => {
    expect(() => deepHash(() => {})).toThrow('not supported');
  });

  // --- Class instances (v2 behavior) ---

  it('class with [hashCode] → uses symbol', () => {
    class Money {
      constructor(
        readonly amount: number,
        readonly currency: string,
      ) {}
      [equals](other: unknown): boolean {
        return (
          other instanceof Money &&
          this.amount === other.amount &&
          this.currency === other.currency
        );
      }
      [hashCode](): number {
        return this.amount * 31 + this.currency.length;
      }
    }
    const a = new Money(100, 'USD');
    const b = new Money(100, 'USD');
    expect(deepHash(a)).toBe(deepHash(b));
  });

  it('registered type → uses registry', () => {
    class Vec2 {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    deepEqual.register(
      Vec2,
      (a, b) => a.x === b.x && a.y === b.y,
      (v) => v.x * 31 + v.y,
    );
    expect(deepHash(new Vec2(1, 2))).toBe(deepHash(new Vec2(1, 2)));
    expect(deepHash(new Vec2(1, 2))).not.toBe(deepHash(new Vec2(3, 4)));
  });

  it('class without handler → throws', () => {
    class Opaque {
      constructor(readonly id: string) {}
    }
    expect(() => deepHash(new Opaque('a'))).toThrow('has no [hashCode]');
  });

  it('[hashCode] takes priority over registry', () => {
    class Token {
      constructor(readonly value: number) {}
      [hashCode](): number {
        return 42;
      }
      [equals](other: unknown): boolean {
        return other instanceof Token && this.value === other.value;
      }
    }
    deepEqual.register(
      Token,
      () => false,
      () => 999,
    );
    expect(deepHash(new Token(1))).toBe(42);
  });

  it('deepEqual + deepHash consistency for custom types', () => {
    class Pair {
      constructor(
        readonly a: number,
        readonly b: number,
      ) {}
      [equals](other: unknown): boolean {
        return other instanceof Pair && this.a === other.a && this.b === other.b;
      }
      [hashCode](): number {
        return this.a * 37 + this.b;
      }
    }
    const p1 = new Pair(1, 2);
    const p2 = new Pair(1, 2);
    const p3 = new Pair(3, 4);
    expect(deepEqual(p1, p2)).toBe(true);
    expect(deepHash(p1)).toBe(deepHash(p2));
    expect(deepEqual(p1, p3)).toBe(false);
  });
});

describe('deepHash — diagnostic for unregistered Temporal', () => {
  // Native Temporal is a recent-Node feature; on the runtime-floor CI leg
  // there is no global to build a value from, so this one case skips.
  it.skipIf(typeof (globalThis as { Temporal?: unknown }).Temporal === 'undefined')(
    'points at the valsem/temporal import',
    () => {
    expect(() => deepHash((globalThis as { Temporal?: any }).Temporal.PlainDate.from('2026-08-31'))).toThrow(
      /import 'valsem\/temporal'/,
    );
    },
  );

  it('keeps the generic message for other unregistered classes', () => {
    class Whatever {}
    expect(() => deepHash(new Whatever())).toThrow(
      /class instance 'Whatever' has no \[hashCode\] or registered hash handler/,
    );
  });
});

describe('deepHash — own keys only (prototype pollution cannot split the invariant)', () => {
  it('an Object.prototype record and an equal null-prototype record hash alike under pollution', () => {
    const a = { x: 1 };
    const b = Object.assign(Object.create(null), { x: 1 }) as Record<string, unknown>;
    expect(deepEqual(a, b)).toBe(true);
    (Object.prototype as unknown as Record<string, unknown>)['polluted'] = 7;
    try {
      expect(deepEqual(a, b)).toBe(true);
      expect(deepHash(a)).toBe(deepHash(b));
      expect(deepHash({ x: 1 })).toBe(deepHash(a));
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['polluted'];
    }
  });
});
