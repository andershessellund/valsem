// ---------------------------------------------------------------------------
// deepEqual — tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';

describe('deepEqual', () => {
  // --- Primitives ---

  it('identical primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it('different primitives', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(0, '')).toBe(false);
  });

  it('NaN equals NaN', () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
  });

  it('+0 and -0 are equal (Object.is says false, but both are 0)', () => {
    // +0 === -0 is true, so deepEqual treats them as equal
    expect(deepEqual(+0, -0)).toBe(true);
  });

  // --- Objects ---

  it('equal plain objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('different values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('different keys', () => {
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('different key count', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('nested objects', () => {
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
  });

  it('object vs non-object', () => {
    expect(deepEqual({ a: 1 }, null)).toBe(false);
    expect(deepEqual({ a: 1 }, 1)).toBe(false);
    expect(deepEqual({ a: 1 }, [1])).toBe(false);
  });

  // --- Arrays ---

  it('equal arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('different length', () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('different elements', () => {
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });

  it('nested arrays', () => {
    expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
    expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
  });

  it('array vs object', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  // --- Mutable built-ins: reference semantics, not value semantics ---
  //
  // valsem gives value semantics to immutable values only. deepEqual is a total
  // function and cannot throw, so it reports these as unequal; deepHash rejects
  // them outright (see deep-hash.test.ts).

  it('Map falls back to reference semantics', () => {
    const m = new Map([['a', 1]]);
    expect(deepEqual(m, m)).toBe(true);
    expect(deepEqual(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false);
    expect(deepEqual(new Map([['x', { a: 1 }]]), new Map([['x', { a: 1 }]]))).toBe(false);
  });

  it('Set falls back to reference semantics', () => {
    const st = new Set([1, 2, 3]);
    expect(deepEqual(st, st)).toBe(true);
    expect(deepEqual(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(false);
  });

  it('Date falls back to reference semantics', () => {
    const d = new Date(1000);
    expect(deepEqual(d, d)).toBe(true);
    expect(deepEqual(new Date(1000), new Date(1000))).toBe(false);
    expect(deepEqual(new Date(1000), new Date(2000))).toBe(false);
  });

  it('RegExp falls back to reference semantics', () => {
    const r = /abc/gi;
    expect(deepEqual(r, r)).toBe(true);
    expect(deepEqual(/abc/gi, /abc/gi)).toBe(false);
    expect(deepEqual(/abc/gi, /abc/g)).toBe(false);
  });

  it('a mutable built-in nested in a record makes the record unequal', () => {
    expect(deepEqual({ at: new Date(0) }, { at: new Date(0) })).toBe(false);
    expect(deepEqual({ tags: new Set([1]) }, { tags: new Set([1]) })).toBe(false);
  });

  // --- TypedArray ---

  it('TypedArrays fall back to reference semantics (bytes are never immutable)', () => {
    const ta = new Uint8Array([1, 2, 3]);
    expect(deepEqual(ta, ta)).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(deepEqual(new Float64Array([1]), new Float64Array([1]))).toBe(false);
  });

  it('same reference returns true immediately', () => {
    const obj = { a: 1, b: { c: 2 } };
    expect(deepEqual(obj, obj)).toBe(true);
  });

  // --- Class instances (v2 behavior) ---

  it('class instance without [equals] → false (reference semantics)', () => {
    class Foo {
      constructor(public x: number) {}
    }
    expect(deepEqual(new Foo(1), new Foo(1))).toBe(false);
  });

  it('same class instance reference → true', () => {
    class Foo {
      constructor(public x: number) {}
    }
    const f = new Foo(1);
    expect(deepEqual(f, f)).toBe(true);
  });

  it('class instance with [equals] → delegates to symbol method', () => {
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
        return this.amount;
      }
    }
    expect(deepEqual(new Money(100, 'USD'), new Money(100, 'USD'))).toBe(true);
    expect(deepEqual(new Money(100, 'USD'), new Money(200, 'USD'))).toBe(false);
    expect(deepEqual(new Money(100, 'USD'), new Money(100, 'EUR'))).toBe(false);
  });

  it('[equals] takes priority over registry', () => {
    class Widget {
      constructor(readonly id: number) {}
      [equals](other: unknown): boolean {
        return other instanceof Widget && this.id === other.id;
      }
      [hashCode](): number {
        return this.id;
      }
    }
    // Register a handler that always returns false
    deepEqual.register(
      Widget,
      () => false,
      (w) => w.id,
    );
    // [equals] should still win
    expect(deepEqual(new Widget(1), new Widget(1))).toBe(true);
  });

  it('registered type via deepEqual.register → delegates to registered function', () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    deepEqual.register(
      Point,
      (a, b) => a.x === b.x && a.y === b.y,
      (p) => p.x * 31 + p.y,
    );
    expect(deepEqual(new Point(1, 2), new Point(1, 2))).toBe(true);
    expect(deepEqual(new Point(1, 2), new Point(3, 4))).toBe(false);
  });

  it('nested plain object containing class instance → class uses reference, rest uses structural', () => {
    class Service {
      constructor(readonly name: string) {}
    }
    const svc = new Service('auth');
    expect(deepEqual({ a: 1, svc }, { a: 1, svc })).toBe(true);
    expect(deepEqual({ a: 1, svc }, { a: 1, svc: new Service('auth') })).toBe(false);
  });

  it('different constructors → false even with same property shape', () => {
    class A {
      constructor(readonly x: number) {}
    }
    class B {
      constructor(readonly x: number) {}
    }
    expect(deepEqual(new A(1), new B(1))).toBe(false);
  });

  it('null prototype objects are compared structurally', () => {
    const a = Object.create(null);
    a.x = 1;
    const b = Object.create(null);
    b.x = 1;
    expect(deepEqual(a, b)).toBe(true);
  });
});

describe('deepEqual — undefined is not a value in records', () => {
  it('an undefined-valued key equals an absent key', () => {
    expect(deepEqual({ a: undefined }, {})).toBe(true);
    expect(deepEqual({}, { a: undefined })).toBe(true);
    expect(deepEqual({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
    expect(deepEqual({ x: { a: undefined } }, { x: {} })).toBe(true);
  });

  it('the spread/optional-argument idiom no longer produces unequal states', () => {
    const opts = (verbose?: boolean) => ({ level: 3, verbose });
    expect(deepEqual(opts(undefined), { level: 3 })).toBe(true);
    expect(deepEqual(opts(true), { level: 3 })).toBe(false);
  });

  it('a defined value still differs from absence', () => {
    expect(deepEqual({ a: null }, {})).toBe(false); // null IS a value
    expect(deepEqual({ a: 1 }, { a: undefined })).toBe(false);
  });

  it('arrays stay positional — an undefined element is not erased', () => {
    expect(deepEqual([undefined], [])).toBe(false);
    expect(deepEqual([undefined], [undefined])).toBe(true);
  });
});

describe('deepEqual — canonical fast path', () => {
  // Canonicality makes equal content the SAME instance, so deepEqual answers
  // for two distinct canonical values in O(1), without a structural walk.
  it('distinct canonical plain values compare unequal without a walk', async () => {
    const { intern } = await import('./intern.js');
    const a = intern({ k: 1, deep: [1, 2, 3] });
    const b = intern({ k: 2, deep: [1, 2, 3] });
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(intern([1, 2]), intern([1, 3]))).toBe(false);
  });

  it('canonical vs equal raw still walks (and answers true)', async () => {
    const { intern } = await import('./intern.js');
    const canonical = intern({ k: 1, deep: [1, 2, 3] });
    expect(deepEqual(canonical, { deep: [1, 2, 3], k: 1 })).toBe(true);
    expect(deepEqual({ deep: [1, 2, 3], k: 1 }, canonical)).toBe(true);
    expect(deepEqual(canonical, { deep: [1, 2, 3], k: 9 })).toBe(false);
  });

  it('mixed trees terminate at canonical boundaries', async () => {
    const { intern } = await import('./intern.js');
    const shared = intern({ payload: [1, 2, 3] });
    const rawX = { meta: 1, data: shared };
    const rawY = { meta: 1, data: shared };
    expect(deepEqual(rawX, rawY)).toBe(true);
    const other = intern({ payload: [1, 2, 4] });
    expect(deepEqual({ meta: 1, data: shared }, { meta: 1, data: other })).toBe(false);
  });

  it('canonical collections of different kinds are unequal', async () => {
    const { ValueMap } = await import('./value-map.js');
    const { ValueSet } = await import('./value-set.js');
    expect(deepEqual(ValueMap.empty(), ValueSet.empty())).toBe(false);
  });

  it('distinct precomputed [hashCode]s skip [equals] entirely', () => {
    let equalsCalls = 0;
    class Tagged {
      declare readonly [hashCode]: number;
      constructor(readonly tag: string, h: number) {
        (this as Record<symbol, unknown>)[hashCode as unknown as symbol] = h;
      }
      [equals](other: unknown): boolean {
        equalsCalls++;
        return other instanceof Tagged && other.tag === this.tag;
      }
    }
    // Companion invariant: unequal hashes prove inequality — no [equals] call.
    expect(deepEqual(new Tagged('a', 1), new Tagged('b', 2))).toBe(false);
    expect(equalsCalls).toBe(0);
    // Equal hashes still require the real comparison.
    expect(deepEqual(new Tagged('a', 7), new Tagged('a', 7))).toBe(true);
    expect(deepEqual(new Tagged('a', 7), new Tagged('b', 7))).toBe(false);
    expect(equalsCalls).toBe(2);
  });
});

describe('deepEqual — the [interned] type contract', () => {
  // [interned] marks auto-interning TYPES: every instance is canonical by
  // construction (no public non-interning constructor). deepEqual therefore
  // concludes on ANY non-identical pair with a marked side — same type would
  // mean both marked, so a mixed pair is cross-kind.
  it('a marked value never deep-equals anything it is not identical to', async () => {
    const { createInternPool } = await import('./intern-pool.js');
    const pool = createInternPool<Pt>();
    class Pt {
      declare readonly [hashCode]: number;
      constructor(readonly x: number) {
        (this as Record<symbol, unknown>)[hashCode as unknown as symbol] = x >>> 0;
      }
      [equals](other: unknown): boolean {
        return other instanceof Pt && other.x === this.x;
      }
    }
    const canonical = pool.intern(new Pt(42));
    expect((canonical as Record<symbol, unknown>)[interned as unknown as symbol]).toBe(true);
    expect(deepEqual(canonical, canonical)).toBe(true); // identity
    expect(deepEqual(canonical, pool.intern(new Pt(43)))).toBe(false); // distinct canonicals
    expect(deepEqual(canonical, { x: 42 })).toBe(false); // cross-kind
    // An unmarked instance of a marked type is a CONTRACT VIOLATION (the
    // type must not expose non-interning construction); under the contract
    // the marked side concludes without walking:
    expect(deepEqual(canonical, new Pt(42))).toBe(false);
  });

  it('marked collections conclude against everything non-identical', async () => {
    const { ValueMap } = await import('./value-map.js');
    const m = ValueMap.fromObject({ a: 1 });
    expect(deepEqual(m, ValueMap.fromObject({ a: 1 }))).toBe(true); // same canonical
    expect(deepEqual(m, ValueMap.fromObject({ a: 2 }))).toBe(false);
    expect(deepEqual(m, { a: 1 })).toBe(false); // maps are not records
  });
});

describe('mutable built-ins — tier-1 registration is contained', () => {
  // The escape hatch: an app MAY register equality/hash for a mutable
  // built-in (without { immutable: true }). deepEqual/deepHash then answer —
  // but canonicalization still refuses: rejection is independent of
  // registration, so no mutable instance can reach a pool, a collection, or
  // a HashMap key.
  //
  // ORDER-SENSITIVE: registration is global and has no unregister; this
  // block must stay LAST in the file — the reference-semantics Date tests
  // above rely on running before it.
  it('registering Date enables comparison but never interning', async () => {
    deepEqual.register(
      Date,
      (a, b) => a.getTime() === b.getTime(),
      (d) => d.getTime() >>> 0,
    );
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    const { deepHash } = await import('./deep-hash.js');
    expect(typeof deepHash(new Date(5))).toBe('number');
    const { intern } = await import('./intern.js');
    expect(() => intern(new Date(5))).toThrow(/Temporal\.Instant/);
    expect(() => intern({ at: new Date(5) })).toThrow(/Temporal\.Instant/);
  });
});
