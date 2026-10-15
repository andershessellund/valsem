// ---------------------------------------------------------------------------
// Hashing is parametric in the hasher: `deepHash(value, hasher)` hashes any
// value under any Hasher, through the `[hash](hasher)` protocol method, with
// the companion invariant holding under every hasher — and incrementally,
// since what cannot change is remembered per hasher.
//
// A law of the whole library, so the per-type parts run over the roster; the
// generated-value form is in property-values.test.ts, the cross-process form
// (two seeds, one key, one hash) in hash-reproducible.test.ts.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { deepEqual, equals, hash, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern, isCanonical } from './intern.js';
import { HashMap } from './hash-map.js';
import { createInternPool } from './intern-pool.js';
import { createMarvin32Hasher, mix, type Hasher } from './hasher.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { InternedString } from './interned-string.js';
import { produce } from './produce.js';
import { COLLECTIONS, VALUE_TYPES } from './roster.test-helpers.js';

const h1 = createMarvin32Hasher(0x1234_5678, 0x9abc_def0);
const h2 = createMarvin32Hasher(0x0bad_f00d, 0x7357_7357);

/** Two hashes of unrelated things are very unlikely to coincide; across `n` draws they must not all. */
function differ(a: (x: number) => number, b: (x: number) => number, n = 16): boolean {
  let same = 0;
  for (let i = 0; i < n; i++) if (a(i) === b(i)) same++;
  return same < n / 4;
}

describe('the [hash] protocol', () => {
  class Money {
    constructor(
      readonly amount: number,
      readonly currency: string,
    ) {}
    [equals](o: unknown): boolean {
      return o instanceof Money && o.amount === this.amount && o.currency === this.currency;
    }
    [hash](hasher: Hasher): number {
      return deepHash([this.amount, this.currency], hasher);
    }
  }

  it('is a global, versioned symbol like the others', () => {
    expect(hash).toBe(Symbol.for('valsem.hash.v1'));
    expect(hash).not.toBe(hashCode);
  });

  it('makes a class a value: hashed, interned, a key — and hashed under any other hasher', () => {
    const a = new Money(5, 'EUR');
    const b = new Money(5, 'EUR');
    expect(deepEqual(a, b)).toBe(true);
    expect(deepHash(a)).toBe(deepHash(b));
    expect(deepHash(a, h1)).toBe(deepHash(b, h1));
    expect(deepHash(a, h2)).toBe(deepHash(b, h2));
    expect(deepHash(a, h1)).toBe(deepHash([5, 'EUR'], h1)); // what the method says it is
    expect(differ((i) => deepHash(new Money(i, 'EUR')), (i) => deepHash(new Money(i, 'EUR'), h1))).toBe(true);
    expect(differ((i) => deepHash(new Money(i, 'EUR'), h1), (i) => deepHash(new Money(i, 'EUR'), h2))).toBe(true);

    const canonical = intern(a);
    expect(intern(b)).toBe(canonical);
    expect(isCanonical(canonical)).toBe(true);
    expect(deepHash(canonical)).toBe(deepHash(b));
    const m = new HashMap<Money, string>();
    m.set(new Money(5, 'EUR'), 'five');
    expect(m.get(new Money(5, 'EUR'))).toBe('five');
    expect(m.get(new Money(6, 'EUR'))).toBeUndefined();
    expect(ValueSet.from([new Money(1, 'DKK')])).toBe(ValueSet.from([new Money(1, 'DKK')]));
    expect(intern({ price: new Money(1, 'DKK') })).toBe(intern({ price: new Money(1, 'DKK') }));
    expect(deepHash(produce(intern({ price: a }), (d) => void (d.price = new Money(2, 'EUR'))), h1)).toBe(
      deepHash({ price: new Money(2, 'EUR') }, h1),
    );
  });

  it('under the active hasher, [hash] runs once per canonical instance: intern caches what it computed', () => {
    let calls = 0;
    class Counted {
      constructor(readonly v: number) {}
      [equals](o: unknown): boolean {
        return o instanceof Counted && o.v === this.v;
      }
      [hash](hasher: Hasher): number {
        calls++;
        return hasher.number(this.v);
      }
    }
    const raw = new Counted(7);
    expect(deepHash(raw)).toBe(deepHash(raw));
    expect(calls).toBe(2); // a raw instance is hashed each time, as a [hashCode] method would be
    const c = intern(raw);
    expect(c).toBe(raw); // adopted: the first instance of a value is its canonical
    const after = calls;
    expect(deepHash(c)).toBe(deepHash(new Counted(7)));
    expect(deepHash({ c })).toBe(deepHash({ c }));
    expect(calls).toBe(after + 1); // the fresh one in the comparison; the canonical one read its cache
    // Under another hasher, once as well: the result is kept in that hasher's cache.
    const u = deepHash(c, h1);
    const then = calls;
    expect(deepHash(c, h1)).toBe(u);
    expect(deepHash([c, c], h1)).toBe(deepHash([c, c], h1));
    expect(calls).toBe(then);
    expect(deepHash(c, h2)).not.toBe(u); // (with overwhelming probability)
    expect(calls).toBe(then + 1);
  });

  it('pool.intern stamps the hash it computed as [hashCode], beside the marker', () => {
    const pool = createInternPool<Point>();
    class Point {
      declare readonly [interned]: true;
      declare readonly [hashCode]: number;
      private constructor(
        readonly x: number,
        readonly y: number,
      ) {}
      [equals](o: unknown): boolean {
        return o instanceof Point && o.x === this.x && o.y === this.y;
      }
      [hash](hasher: Hasher): number {
        return mix(hasher.number(this.x), hasher.number(this.y));
      }
      static of(x: number, y: number): Point {
        return pool.intern(new Point(x, y));
      }
    }
    const p = Point.of(1, 2);
    expect(Point.of(1, 2)).toBe(p);
    expect(p[interned]).toBe(true);
    expect(Object.hasOwn(p, hashCode)).toBe(true);
    expect(p[hashCode]).toBe(deepHash(p));
    expect(Object.isFrozen(p)).toBe(true);
    expect(deepHash(p, h1)).toBe(deepHash(Point.of(1, 2), h1));
    expect(deepHash(p, h1)).not.toBe(p[hashCode]);
    expect(new HashMap<Point, number>().set(p, 1).get(Point.of(1, 2))).toBe(1);
  });

  it('a class with [hashCode] and no [hash] is not a value: the form before 0.2, refused with the reason', () => {
    // The number was computed any way at all — here through deepHash, as
    // the README once showed; often not — and the hasher valsem interns
    // with never saw it: a seeded hash, or a SipHash plugged in, did not
    // cover the class, and nothing said so.
    class Legacy {
      readonly [hashCode]: number;
      constructor(readonly v: number) {
        this[hashCode] = deepHash(['Legacy', v]);
      }
      [equals](o: unknown): boolean {
        return o instanceof Legacy && o.v === this.v;
      }
    }
    const refused = /Legacy carries a \[hashCode\] but no \[hash\].*hasher valsem interns with.*configureHasher.*\[hashCode\] is valsem's cache/s;
    expect(() => deepHash(new Legacy(1))).toThrow(refused);
    expect(() => intern(new Legacy(1))).toThrow(refused);
    expect(() => new HashMap<Legacy, string>().set(new Legacy(1), 'one')).toThrow(refused);
    expect(() => deepHash(new Legacy(1), h1)).toThrow(refused);
    expect(() => deepHash({ nested: [new Legacy(1)] }, h1)).toThrow(refused);
    expect(() => deepHash(ValueList.of(new Legacy(1)), h1)).toThrow(refused);
    expect(deepEqual(new Legacy(1), new Legacy(1))).toBe(true); // comparable, by its [equals]
  });

  it('[hashCode] beside [hash] is read as the cache under the active hasher, and never under another', () => {
    // The slot is valsem's to write (a pool stamps it); a class that fills it
    // itself is trusted as a pool would be, under the active hasher only.
    class Both {
      constructor(readonly v: number) {}
      get [hashCode](): number {
        return 42;
      }
      [equals](o: unknown): boolean {
        return o instanceof Both && o.v === this.v;
      }
      [hash](hasher: Hasher): number {
        return hasher.number(this.v);
      }
    }
    expect(deepHash(new Both(1))).toBe(42);
    expect(deepHash(new Both(1), h1)).toBe(h1.number(1));
  });

  it('the registry form: a hashFn written for the hasher serves every hasher; one of a single parameter is refused at registration', () => {
    class Vec {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    deepEqual.register(
      Vec,
      (a, b) => a.x === b.x && a.y === b.y,
      (v, hasher) => deepHash([v.x, v.y], hasher),
    );
    expect(deepHash(new Vec(1, 2))).toBe(deepHash(new Vec(1, 2)));
    expect(deepHash(new Vec(1, 2), h1)).toBe(deepHash([1, 2], h1));
    expect(intern(new Vec(1, 2))).toBe(intern(new Vec(1, 2)));

    class Old {
      constructor(readonly id: string) {}
    }
    // The form before 0.2, refused where it is written, not where it is used.
    expect(() =>
      deepEqual.register(
        Old,
        (a, b) => a.id === b.id,
        (o) => deepHash(o.id),
      ),
    ).toThrow(/the hashFn for Old takes one parameter.*\(value, hasher\) => …/s);
    expect(() => deepHash(new Old('a'))).toThrow(/has no \[hash\] or registered/); // nothing was registered
  });

  it('[hash] is read off the prototype, like [equals]: an own property is not the protocol', () => {
    class Own {
      [hash] = (hasher: Hasher): number => hasher.number(1);
      [equals](o: unknown): boolean {
        return o instanceof Own;
      }
    }
    expect(() => deepHash(new Own())).toThrow(/has an equality but no hash/);
    expect(() => deepHash(new Own(), h1)).toThrow(/has an equality but no hash/);
    // On a record, the symbol is an ordinary key — and a function is not a value.
    expect(() => deepHash({ [hash]: () => 1 }, h1)).toThrow(/function/);
    expect(deepHash({ [hash]: 1 }, h1)).not.toBe(deepHash({}, h1));
  });

  it('is a reserved key in a draft, as the other protocol symbols are', () => {
    expect(() => produce(intern({ a: 1 }), (d) => void ((d as Record<symbol, unknown>)[hash] = 1))).toThrow(
      /reserved protocol key/,
    );
  });

  it('what is refused under the active hasher is refused under another, with the same words', () => {
    expect(() => deepHash(new Date(0), h1)).toThrow(/ValueDate/);
    expect(() => deepHash(new Map(), h1)).toThrow(/ValueMap/);
    expect(() => deepHash(() => 1, h1)).toThrow(/function/);
    expect(() => deepHash(new (class Opaque {})(), h1)).toThrow(/has no \[hash\] or registered/);
    class Half {
      [equals](): boolean {
        return true;
      }
    }
    expect(() => deepHash(new Half(), h1)).toThrow(/has an equality but no hash/);
  });

  it('the active hasher, handed to [hash], takes the baked-in path: the one hash, whichever door', () => {
    class Holder {
      constructor(readonly list: ValueList<number>) {}
      [equals](o: unknown): boolean {
        return o instanceof Holder && o.list === this.list;
      }
      [hash](hasher: Hasher): number {
        return deepHash(this.list, hasher);
      }
    }
    const l = ValueList.of(1, 2, 3);
    expect(deepHash(new Holder(l))).toBe(l[hashCode]);
    expect(deepHash(new Holder(l), h1)).toBe(deepHash(l, h1));
    expect(deepHash(l, h1)).not.toBe(l[hashCode]);
  });
});

describe('plain data under another hasher', () => {
  it('the same combiners, other leaves: equal structure agrees, order matters where it does', () => {
    expect(deepHash({ a: 1, b: [2, 'x'] }, h1)).toBe(deepHash({ b: [2, 'x'], a: 1 }, h1));
    expect(deepHash({ a: 1, b: undefined }, h1)).toBe(deepHash({ a: 1 }, h1));
    expect(deepHash([1, 2], h1)).not.toBe(deepHash([2, 1], h1));
    expect(deepHash(-0, h1)).toBe(deepHash(0, h1));
    expect(deepHash(NaN, h1)).toBe(deepHash(0 / 0, h1));
    expect(deepHash(10n ** 30n, h1)).toBe(deepHash(10n ** 30n, h1));
    expect(deepHash(Symbol.for('k'), h1)).toBe(deepHash(Symbol.for('k'), h1));
    const u = Symbol('u');
    expect(deepHash({ [u]: 1 }, h1)).toBe(deepHash({ [u]: 1 }, h1));
    expect(deepHash({ [u]: 1 }, h1)).not.toBe(deepHash({ [Symbol('u')]: 1 }, h1));
    expect(deepHash(null, h1)).toBe(deepHash(null));
    expect(deepHash(true, h1)).toBe(deepHash(true));
    for (const v of ['s', 1, 2n, { a: 1 }, [1], Symbol.for('k')]) {
      expect(deepHash(v, h1), String(v)).not.toBe(deepHash(v));
      expect(deepHash(v, h1), String(v)).not.toBe(deepHash(v, h2));
    }
  });

  it('canonical and raw agree; a draft hashes as its value', () => {
    const raw = { a: [1, { b: 's' }], c: InternedString.for('x') };
    const c = intern(raw);
    expect(deepHash(c, h1)).toBe(deepHash(raw, h1));
    expect(deepHash(c, h1)).toBe(deepHash(c, h1));
    produce(c, (d) => {
      expect(deepHash(d, h1)).toBe(deepHash(c, h1));
      d.a.push(2);
      expect(deepHash(d, h1)).toBe(deepHash({ a: [1, { b: 's' }, 2], c: InternedString.for('x') }, h1));
    });
  });

  it('is depth-capped like the active walk', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => deepHash(cyclic, h1)).toThrow(/depth/i);
    expect(deepHash({ a: 1 }, h1)).toBe(deepHash({ a: 1 }, h1)); // the counter unwound
  });
});

describe.each(VALUE_TYPES.map((t) => [t.name, t] as const))('%s under another hasher', (_name, t) => {
  it('hashes under it, the same for an equal built separately, differently from the active hash and from another key', () => {
    const v = t.sample();
    const u = deepHash(v, h1);
    expect(Number.isInteger(u) && u >= 0 && u <= 0xffffffff).toBe(true);
    expect(deepHash(v, h1)).toBe(u);
    if (t.byContent) expect(deepHash(t.sample(), h1)).toBe(u);
    else expect(deepHash(t.sample(), h1)).not.toBe(u); // a RawArray is a value by identity: another view, another value
    expect(u).not.toBe(deepHash(v));
    expect(u).not.toBe(deepHash(v, h2));
    // The protocol method itself, called with that hasher, says the same.
    expect((v as { [hash](h: Hasher): number })[hash](h1)).toBe(u);
    // Inside plain data, the same number is folded in.
    if (t.byContent) expect(deepHash({ v: t.sample() }, h1)).toBe(deepHash({ v }, h1));
    expect(deepHash({ v }, h1)).not.toBe(deepHash({ v }, h2));
  });
});

describe.each(COLLECTIONS.map((c) => [c.name, c] as const))('%s under another hasher', (_name, c) => {
  it('is a function of the content: bulk, chained, and edited builds agree', () => {
    const items = ['a', 'b', { k: 1 }, 3, 'd'];
    const bulk = c.of(...items);
    const chained = c.chained(...items);
    expect(chained).toBe(bulk);
    const u = deepHash(bulk, h1);
    expect(deepHash(chained, h1)).toBe(u);
    const detour = c.add(bulk, 'spare');
    expect(detour).not.toBe(bulk);
    expect(deepHash(detour, h1)).not.toBe(u);
    expect(deepHash(c.of(...items, 'spare'), h1)).toBe(deepHash(detour, h1));
    expect(deepHash(c.empty(), h1)).toBe(deepHash(c.empty(), h1));
    expect(deepHash(c.empty(), h1)).not.toBe(u);
  });

  it('order counts where it is part of the value, and nowhere else', () => {
    const ab = c.of('a', 'b');
    const ba = c.of('b', 'a');
    if (c.ordered) {
      expect(deepHash(ab, h1)).not.toBe(deepHash(ba, h1));
    } else {
      expect(ba).toBe(ab);
      expect(deepHash(ab, h1)).toBe(deepHash(ba, h1));
    }
  });

  it('a draft hashes as its current value', () => {
    const base = c.of('a');
    produce(base, (d) => {
      expect(deepHash(d, h1)).toBe(deepHash(base, h1));
      c.draftAdd(d, 'b');
      expect(deepHash(d, h1)).toBe(deepHash(c.of('a', 'b'), h1));
    });
  });
});

describe('reproducibility', () => {
  it('two hashers with the same key agree on everything; different keys differ', () => {
    const twin = createMarvin32Hasher(0x1234_5678, 0x9abc_def0);
    const values: unknown[] = [
      'text',
      -1.5,
      { a: [1, 2, { b: 'c' }], d: null },
      ValueList.from(Array.from({ length: 300 }, (_, i) => i)),
      ValueMap.from<unknown, unknown>([
        ['x', 1],
        [{ k: 2 }, [3]],
      ]),
      ValueSet.from(['a', 'b', 3]),
      OrderedMap.from([
        ['b', 2],
        ['a', 1],
      ]),
      InternedString.for('s'),
    ];
    for (const v of values) {
      expect(deepHash(v, twin)).toBe(deepHash(v, h1));
      expect(deepHash(v, h2)).not.toBe(deepHash(v, h1));
    }
  });
});

describe('the memory is the hasher\'s own', () => {
  it('a hasher without one is refused, naming what makes one', () => {
    const bare: Hasher = { string: h1.string, number: h1.number };
    expect(() => deepHash({ a: 1 }, bare)).toThrow(/must remember what it hashes \(recall and remember\).*createMarvin32Hasher/);
    expect(() => deepHash(ValueList.of(1), bare)).toThrow(/recall and remember/);
    expect(() => deepHash(1, bare)).toThrow(/recall and remember/); // the contract is the hasher's, whatever the value
    // The active walk never asks for one: a bare hasher is what `configureHasher` takes.
    expect(typeof bare.recall).toBe('undefined');
  });

  it('is asked before a walk and told after, for what cannot change, and however the hasher keeps it', () => {
    // A hasher that remembers in a Map of its own, counting: valsem does not
    // know or care that it is not a WeakMap.
    const kept = new Map<object, number>();
    let recalls = 0;
    const counting: Hasher = {
      string: h1.string,
      number: h1.number,
      recall: (obj) => {
        recalls++;
        return kept.get(obj);
      },
      remember: (obj, hash) => void kept.set(obj, hash),
    };
    const list = ValueList.from(Array.from({ length: 100 }, (_, i) => ({ i })));
    const first = deepHash(list, counting);
    expect(first).toBe(deepHash(list, h1)); // the key is what decides the hash, not the memory
    expect(kept.size).toBeGreaterThan(100); // the elements, canonical records, and the list's nodes
    const asked = recalls;
    expect(deepHash(list, counting)).toBe(first);
    expect(recalls - asked).toBe(1); // the second hash is one recall: the root's
    // A raw record is not remembered: it may change.
    const raw = { a: [1, 2] };
    deepHash(raw, counting);
    expect(kept.has(raw)).toBe(false);
    expect(kept.has(raw.a)).toBe(false);
  });
});

describe('incrementality', () => {
  it('a ValueList hashed after each of 20,000 pushes costs what the pushes do, not their square', () => {
    const hasher = createMarvin32Hasher(1, 2);
    const time = (n: number): number => {
      let l = ValueList.empty<number>();
      let acc = 0;
      const t = performance.now();
      for (let i = 0; i < n; i++) {
        l = l.pushed(i);
        acc ^= deepHash(l, hasher);
      }
      expect(acc).toBeTypeOf('number');
      return performance.now() - t;
    };
    time(2_000); // warm
    const small = time(2_000);
    const large = time(20_000);
    // Linear: ten times the pushes, about ten times the time; quadratic
    // would be a hundred. The bound is generous, for a loaded CI machine.
    expect(large).toBeLessThan(Math.max(small * 40, 400));
    // And the hash is the content's: the same as from a bulk build, under a fresh hasher of the same key.
    let l = ValueList.empty<number>();
    for (let i = 0; i < 20_000; i++) l = l.pushed(i);
    expect(deepHash(l, hasher)).toBe(deepHash(ValueList.from(Array.from({ length: 20_000 }, (_, i) => i)), createMarvin32Hasher(1, 2)));
  });

  it('a ValueMap edited one entry at a time, likewise', () => {
    const hasher = createMarvin32Hasher(3, 4);
    const time = (n: number): number => {
      let m = ValueMap.empty<number, number>();
      let acc = 0;
      const t = performance.now();
      for (let i = 0; i < n; i++) {
        m = m.with(i, i);
        acc ^= deepHash(m, hasher);
      }
      expect(acc).toBeTypeOf('number');
      return performance.now() - t;
    };
    time(1_000);
    const small = time(1_000);
    const large = time(10_000);
    expect(large).toBeLessThan(Math.max(small * 40, 400));
  });
});

const gc = (globalThis as { gc?: () => void }).gc;
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

describe.skipIf(typeof gc !== 'function')('the cache is per hasher, and weak (needs --expose-gc)', () => {
  async function collected(finalized: () => boolean, rounds = 20): Promise<boolean> {
    for (let i = 0; i < rounds; i++) {
      if (finalized()) return true;
      await turn();
      gc!();
      await turn();
    }
    return finalized();
  }

  it('holds neither the values it remembers nor the hasher it remembers them for', async () => {
    const gone = new Set<string>();
    const registry = new FinalizationRegistry<string>((what) => gone.add(what));
    (function hashAndDrop() {
      const hasher = createMarvin32Hasher(5, 6);
      registry.register(hasher, 'hasher');
      const value = intern({ big: Array.from({ length: 1000 }, (_, i) => ({ i })) });
      registry.register(value, 'value');
      const list = ValueList.from(Array.from({ length: 500 }, (_, i) => i));
      registry.register(list, 'list');
      deepHash(value, hasher);
      deepHash(list, hasher);
      deepHash(value, h1); // the long-lived hasher remembers it too
      deepHash(list, h1);
    })();
    expect(await collected(() => gone.has('value') && gone.has('list') && gone.has('hasher'))).toBe(true);
  });

  it('two hashers of one key keep separate caches, and a cache serves only its hasher', () => {
    const a = createMarvin32Hasher(7, 8);
    const b = createMarvin32Hasher(7, 8);
    const l = ValueList.from(Array.from({ length: 200 }, (_, i) => i));
    expect(deepHash(l, a)).toBe(deepHash(l, b)); // the same key, the same answer, each from its own walk
    expect(deepHash(l, h2)).not.toBe(deepHash(l, a)); // a cache hit never crosses hashers
  });
});
