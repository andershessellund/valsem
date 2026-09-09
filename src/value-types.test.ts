// ---------------------------------------------------------------------------
// User value types, end to end.
//
// The two tiers of the protocol, by symbol or by registration:
//   - an equality alone makes a class COMPARABLE — deepEqual by content, and
//     nothing more (fine for a mutable object);
//   - an equality plus a hash makes it a VALUE — a hash declares immutability,
//     so intern pools instances, and they go wherever a value goes.
// Anything less is rejected, never passed through: a HashMap keyed by such an
// object would miss every equal lookup silently.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from 'vitest';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern, internHash, isCanonical, fastEquals } from './intern.js';
import { HashMap } from './hash-map.js';
import { HashSet } from './hash-set.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { memoize } from './memoize.js';
import { produce } from './produce.js';

class Money {
  readonly [hashCode]: number;
  constructor(
    readonly amount: number,
    readonly currency: string,
  ) {
    this[hashCode] = deepHash([amount, currency]);
  }
  [equals](o: unknown): boolean {
    return o instanceof Money && o.amount === this.amount && o.currency === this.currency;
  }
}
const eur = (n: number): Money => new Money(n, 'EUR');

describe('a class with [equals] and [hashCode] is a value', () => {
  it('interns to one canonical instance — unfrozen, and not marked [interned]', () => {
    const a = intern(eur(5));
    const b = intern(eur(5));
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(Money);
    expect(intern(a)).toBe(a); // the canonical fast path
    expect(intern(eur(6))).not.toBe(a);
    // A hash declares immutability; the instance is the type's own business.
    expect(Object.isFrozen(a)).toBe(false);
    // The marker is a TYPE contract ("every instance canonical by construction"),
    // which a public constructor cannot honour — so a pooled instance must not
    // carry it, or deepEqual would short-circuit against a fresh equal one.
    expect((a as unknown as Record<symbol, unknown>)[interned]).toBeUndefined();
    expect(isCanonical(a)).toBe(true);
    expect(isCanonical(eur(5))).toBe(false);
    expect(internHash(a)).toBe(deepHash(eur(5)));
  });

  it('a pooled instance equals a fresh equal one, from both sides', () => {
    const a = intern(eur(5));
    expect(deepEqual(a, eur(5))).toBe(true);
    expect(deepEqual(eur(5), a)).toBe(true);
    expect(deepEqual(a, intern(eur(6)))).toBe(false);
    expect(fastEquals(a, intern(eur(5)))).toBe(true);
    expect(() => fastEquals(a, eur(5))).toThrow(/instance of Money/);
  });

  it('converges nested in records, arrays and the collections', () => {
    const r1 = intern({ price: eur(5), tags: [eur(1)] });
    const r2 = intern({ tags: [eur(1)], price: eur(5) });
    expect(r1).toBe(r2);
    expect(r1.price).toBe(intern(eur(5)));
    expect(r1.tags[0]).toBe(intern(eur(1)));
    expect(ValueList.of(eur(1), eur(2))).toBe(ValueList.of(eur(1), eur(2)));
    expect(ValueList.of(eur(1)).get(0)).toBe(intern(eur(1)));
    expect(ValueSet.from([eur(1)])).toBe(ValueSet.from([eur(1)]));
    expect(ValueSet.from([eur(1)]).has(eur(1))).toBe(true);
    expect(ValueMap.from([[eur(1), 'a']]).get(eur(1))).toBe('a');
    expect(ValueMap.from([['k', eur(1)]]).get('k')).toBe(intern(eur(1)));
  });

  it('keys a HashMap and a HashSet by content', () => {
    const m = new HashMap<Money, string>();
    m.set(eur(1), 'one');
    expect(m.get(eur(1))).toBe('one');
    expect(m.has(eur(1))).toBe(true);
    expect(m.has(eur(2))).toBe(false);
    m.set(eur(1), 'uno');
    expect(m.size).toBe(1);
    expect([...m.keys()][0]).toBe(intern(eur(1)));
    expect(m.getOrCreate(eur(1), () => 'never')).toBe('uno');
    expect(m.delete(eur(1))).toBe(true);

    const s = new HashSet<Money>();
    s.add(eur(1)).add(eur(1));
    expect(s.size).toBe(1);
    expect(s.has(eur(1))).toBe(true);
    expect(s.delete(eur(1))).toBe(true);
  });

  it('is a memoize argument and a memoize result', () => {
    const fn = vi.fn((m: Money) => eur(m.amount * 2));
    const double = memoize(fn);
    const r = double(eur(2));
    expect(r).toBe(intern(eur(4)));
    expect(double(eur(2))).toBe(r);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sits inside produce as an opaque leaf, adopted canonical', () => {
    const base = intern({ price: eur(1) });
    const next = produce(base, (d) => {
      d.price = eur(2); // Draft<Money> is Money: the slot takes a value, no cast
    });
    expect(next.price).toBe(intern(eur(2)));
    expect(produce(next, (d) => void (d.price = eur(2)))).toBe(next);
    expect(produce(base, (d) => void (d.price = eur(1)))).toBe(base);
  });

  it('a getter [hashCode] and a method [hashCode] both count', () => {
    class Getter {
      constructor(readonly x: number) {}
      get [hashCode](): number {
        return this.x >>> 0;
      }
      [equals](o: unknown): boolean {
        return o instanceof Getter && o.x === this.x;
      }
    }
    class Method {
      constructor(readonly x: number) {}
      [hashCode](): number {
        return this.x >>> 0;
      }
      [equals](o: unknown): boolean {
        return o instanceof Method && o.x === this.x;
      }
    }
    expect(intern(new Getter(1))).toBe(intern(new Getter(1)));
    expect(intern(new Method(1))).toBe(intern(new Method(1)));
    expect(new HashMap().set(new Getter(1), 'v').get(new Getter(1))).toBe('v');
    expect(new HashMap().set(new Method(1), 'v').get(new Method(1))).toBe('v');
  });

  it('two types colliding on a hash never alias in the pool', () => {
    class A {
      readonly [hashCode] = 0x1234;
      [equals](o: unknown): boolean {
        return o instanceof A;
      }
    }
    class B {
      readonly [hashCode] = 0x1234;
      [equals](o: unknown): boolean {
        return o instanceof B;
      }
    }
    const a = intern(new A());
    const b = intern(new B());
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(A);
    expect(b).toBeInstanceOf(B);
    expect(intern(new A())).toBe(a);
    expect(intern(new B())).toBe(b);
  });
});

describe('a subclass is its own type, to deepEqual and to the pool alike', () => {
  class Euro extends Money {}
  const euro = (n: number): Euro => new Euro(n, 'EUR');
  it('an inherited instanceof-based [equals] does not make the types equal', () => {
    // deepEqual and intern must agree: if they did not, two "equal" values
    // could be two distinct canonicals, and the canonical short-circuit
    // would then call them unequal — a HashMap miss.
    expect(deepEqual(eur(1), euro(1))).toBe(false);
    expect(deepEqual(euro(1), eur(1))).toBe(false);
    expect(deepEqual(euro(1), euro(1))).toBe(true);
    expect(intern(euro(1))).toBe(intern(euro(1)));
    expect(intern(euro(1))).not.toBe(intern(eur(1)));
    expect(deepEqual(intern(euro(1)), intern(eur(1)))).toBe(false);
    expect(new HashMap().set(eur(1), 'm').get(euro(1))).toBeUndefined();
    expect(ValueSet.from([eur(1), euro(1)]).size).toBe(2);
  });
});

describe('[equals] is the type\'s, read off the prototype', () => {
  it('an own [equals] on an instance is not protocol — deepEqual and intern agree', () => {
    class Own {
      readonly [hashCode] = 1;
      readonly [equals] = (o: unknown): boolean => o instanceof Own; // per instance: ignored
    }
    expect(deepEqual(new Own(), new Own())).toBe(false); // reference semantics
    expect(() => intern(new Own())).toThrow(/Own has a hash but no equality/);

    class Proto {
      constructor(readonly v: number) {}
      readonly [hashCode] = 1;
      [equals](o: unknown): boolean {
        return o instanceof Proto && o.v === this.v;
      }
    }
    const p = new Proto(1);
    // An own override on one instance changes nothing: the prototype's answers.
    Object.defineProperty(p, equals, { value: () => false });
    expect(deepEqual(p, new Proto(1))).toBe(true);
    expect(intern(p)).toBe(intern(new Proto(1)));
  });
});

describe('[equals] must answer true, not merely truthy', () => {
  it('a truthy non-boolean is "not equal" to deepEqual and to the pool alike', () => {
    class Loose {
      readonly [hashCode] = 1;
      [equals](o: unknown): boolean {
        return (o instanceof Loose ? 1 : 0) as unknown as boolean; // a contract violation…
      }
    }
    // …answered the same way on both sides, so no two canonicals ever compare equal.
    expect(deepEqual(new Loose(), new Loose())).toBe(false);
    const a = intern(new Loose());
    const b = intern(new Loose());
    expect(a).not.toBe(b);
    expect(deepEqual(a, b)).toBe(false);
  });
});

describe('a non-callable [equals] is no protocol', () => {
  it('is rejected consistently, on the first call and every call after', () => {
    class Weird {
      readonly [equals] = true;
      readonly [hashCode] = 7;
    }
    expect(deepEqual(new Weird(), new Weird())).toBe(false);
    expect(() => intern(new Weird())).toThrow(/Weird has a hash but no equality/);
    expect(() => intern(new Weird())).toThrow(/Weird has a hash but no equality/);
    expect(() => new HashMap().set(new Weird(), 1)).toThrow(/no equality/);
  });
});

describe('deepEqual.register with a hash is the same tier', () => {
  class Vec {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }
  deepEqual.register(Vec, (a, b) => a.x === b.x && a.y === b.y, (v) => deepHash([v.x, v.y]));

  it('interns, keys, and memoizes by content', () => {
    const v = intern(new Vec(1, 2));
    expect(intern(new Vec(1, 2))).toBe(v);
    expect(Object.isFrozen(v)).toBe(false);
    expect(deepEqual(v, new Vec(1, 2))).toBe(true);
    expect(intern({ at: new Vec(1, 2) })).toBe(intern({ at: new Vec(1, 2) }));
    expect(new HashMap().set(new Vec(1, 2), 'v').get(new Vec(1, 2))).toBe('v');
    expect(ValueSet.from([new Vec(1, 2), new Vec(1, 2)]).size).toBe(1);
    const fn = vi.fn((a: Vec) => a.x + a.y);
    const m = memoize(fn);
    expect(m(new Vec(1, 2))).toBe(3);
    expect(m(new Vec(1, 2))).toBe(3);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('accepts private and abstract constructors', () => {
    class P {
      private constructor(readonly v: number) {}
      static of(v: number): P {
        return new P(v);
      }
    }
    deepEqual.register(P, (a, b) => a.v === b.v, (p) => p.v >>> 0);
    expect(intern(P.of(1))).toBe(intern(P.of(1)));

    abstract class Shape {
      abstract area(): number;
    }
    class Square extends Shape {
      constructor(readonly side: number) {
        super();
      }
      area(): number {
        return this.side ** 2;
      }
    }
    deepEqual.register(Square, (a, b) => a.side === b.side, (s) => s.side >>> 0);
    expect(deepEqual(new Square(2), new Square(2))).toBe(true);
    // The registry keys on the exact constructor: a subclass is its own type.
    expect(() => intern(new (class Cube extends Square {})(2))).toThrow(/Cube/);
  });

  it('registering again without a hash drops the hash', () => {
    class R {
      constructor(readonly v: number) {}
    }
    deepEqual.register(R, (a, b) => a.v === b.v, (r) => r.v >>> 0);
    expect(typeof deepHash(new R(1))).toBe('number');
    deepEqual.register(R, (a, b) => a.v === b.v);
    expect(deepEqual(new R(1), new R(1))).toBe(true);
    expect(() => deepHash(new R(1))).toThrow(/has an equality but no hash/);
  });
});

describe('an equality alone is comparable, not a value', () => {
  class Mut {
    constructor(public v: number) {}
    [equals](o: unknown): boolean {
      return o instanceof Mut && o.v === this.v;
    }
  }
  class Reg {
    constructor(public v: number) {}
  }
  deepEqual.register(Reg, (a, b) => a.v === b.v);

  it('deepEqual answers by content', () => {
    expect(deepEqual(new Mut(1), new Mut(1))).toBe(true);
    expect(deepEqual(new Mut(1), new Mut(2))).toBe(false);
    expect(deepEqual(new Reg(1), new Reg(1))).toBe(true);
    expect(deepEqual(new Reg(1), new Reg(2))).toBe(false);
    expect(deepEqual(new Mut(1), new Reg(1))).toBe(false);
  });

  it.each([
    ['[equals] only', () => new Mut(1)],
    ['registered equality only', () => new Reg(1)],
  ])('%s: deepHash and intern throw naming the missing hash, top level and nested', (_n, make) => {
    const missing = /has an equality but no hash/;
    expect(() => deepHash(make())).toThrow(missing);
    expect(() => intern(make())).toThrow(missing);
    expect(() => intern({ v: make() })).toThrow(missing);
    expect(() => intern([make()])).toThrow(missing);
    // The text points at the fix.
    expect(() => intern(make())).toThrow(/\[hashCode\]/);
  });

  it('every entry point refuses it rather than keying by reference', () => {
    const missing = /has an equality but no hash/;
    const m = new HashMap<Mut, number>();
    expect(() => m.set(new Mut(1), 1)).toThrow(missing);
    expect(() => m.get(new Mut(1))).toThrow(missing);
    expect(() => m.has(new Mut(1))).toThrow(missing);
    expect(m.size).toBe(0);
    expect(() => new HashSet<Mut>().add(new Mut(1))).toThrow(missing);
    expect(() => ValueSet.from([new Mut(1)])).toThrow(missing);
    expect(() => ValueMap.from([[new Mut(1), 1]])).toThrow(missing);
    expect(() => ValueMap.from([[1, new Mut(1)]])).toThrow(missing);
    expect(() => ValueList.of(new Mut(1))).toThrow(missing);
    expect(() => memoize((x: Mut) => x.v)(new Mut(1))).toThrow(/is not a value/);
    expect(() => memoize(() => new Mut(1))()).toThrow(/returned an instance of Mut, which is not a value/);
    expect(() =>
      produce(intern({ a: 1 }), (d) => {
        (d as Record<string, unknown>).b = new Mut(1);
      }),
    ).toThrow(missing);
  });
});

describe('anything less is rejected, never passed through', () => {
  it('a class with neither', () => {
    class Foo {
      x = 1;
    }
    const neither = /has no \[hashCode\] or registered hash handler/;
    expect(() => intern(new Foo())).toThrow(neither);
    expect(() => intern({ f: new Foo() })).toThrow(neither);
    expect(() => deepHash(new Foo())).toThrow(neither);
    expect(() => new HashMap().set(new Foo(), 1)).toThrow(neither);
    expect(() => intern(new Foo())).toThrow(/deepEqual\.register\(Foo, equalsFn, hashFn\)/);
    expect(deepEqual(new Foo(), new Foo())).toBe(false); // reference semantics, no throw
  });

  it('a hash without an equality', () => {
    class H {
      readonly [hashCode] = 1;
    }
    expect(() => intern(new H())).toThrow(/has a hash but no equality/);
    expect(() => intern([new H()])).toThrow(/has a hash but no equality/);
    expect(() => new HashSet().add(new H())).toThrow(/has a hash but no equality/);
  });

  it('an instance whose prototype names no constructor', () => {
    const anonymous = Object.create(Object.create(null)) as object;
    expect(() => intern(anonymous)).toThrow(/an anonymous class/);
  });
});

describe('the mutable built-ins', () => {
  it('cannot be registered with a hash — a hash would declare them immutable', () => {
    for (const T of [Map, Set, RegExp, Uint8Array]) {
      expect(() => deepEqual.register(T as never, () => true, () => 1)).toThrow(
        /cannot be registered with a hash/,
      );
    }
  });

  it('a subclass of a mutable built-in is refused like its base', () => {
    class Stamp extends Date {}
    expect(() => deepEqual.register(Stamp, () => true, () => 1)).toThrow(/Stamp cannot be registered with a hash/);
    expect(() => intern(new Stamp(5))).toThrow(/Stamp cannot be interned.*setTime/);
    expect(() => deepHash(new Stamp(5))).toThrow(/setTime/);
    expect(() => intern({ at: new Stamp(5) })).toThrow(/setTime/);
    deepEqual.register(Stamp, (a, b) => a.getTime() === b.getTime()); // comparable is fine
    expect(deepEqual(new Stamp(5), new Stamp(5))).toBe(true);
    // …and carrying the symbol protocol does not smuggle it past deepHash either.
    class Stamped extends Date {
      [equals](o: unknown): boolean {
        return o instanceof Stamped && o.getTime() === this.getTime();
      }
      get [hashCode](): number {
        return this.getTime() >>> 0;
      }
    }
    expect(() => deepHash(new Stamped(5))).toThrow(/setTime/);
    expect(() => intern(new Stamped(5))).toThrow(/setTime/);
    expect(() => memoize((d: Stamped) => d.getTime())(new Stamped(5))).toThrow(/is not a value/);
  });

  it('an equality alone makes them comparable; hashing and interning still refuse', () => {
    deepEqual.register(RegExp, (a, b) => a.source === b.source && a.flags === b.flags);
    expect(deepEqual(/a/g, /a/g)).toBe(true);
    expect(deepEqual(/a/g, /a/i)).toBe(false);
    expect(() => deepHash(/a/g)).toThrow(/source, flags/);
    expect(() => intern(/a/g)).toThrow(/source, flags/);
    expect(() => intern({ re: /a/g })).toThrow(/source, flags/);
    expect(() => new HashMap().set(/a/g, 1)).toThrow(/source, flags/);
  });
});
