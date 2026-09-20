// ---------------------------------------------------------------------------
// Full-hash collisions everywhere they can happen, outside ValueMap and
// ValueSet (hamt-collisions.test.ts has those): the ordered collections'
// anchor tries, the intern pool, memoize's table, and collision nodes whose
// members are of DIFFERENT kinds.
//
// A seeded hasher essentially never collides on all 32 bits, so none of this
// runs in any other suite, and all of it runs in production sooner or later:
// it is the code that keeps two different values apart when their hashes
// cannot.
//
// The hasher here is AIMED. A leaf's hash is `mix(tag, hasher(leaf))`, the
// tag saying what kind of leaf it is, so a hasher that returns a constant
// collides strings with strings and numbers with numbers, never one with the
// other. `mix` is invertible in its second argument, though: for any target
// there is an output that lands a given tag exactly on it. Aiming strings and
// numbers at one target puts them in one collision node; aiming them at the
// fixed hash of `true` (or null, or undefined) puts that in the node too.
//
// This file relies on vitest's per-file process isolation: configureHasher is
// once-per-process, and here it must run before any hashing.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { configureHasher, mix } from './hasher.js';
import { mulberry32, shuffled } from './rng.test-helpers.js';

// The leaf tags of deep-hash.ts. Not exported, and not worth exporting for
// one test: if they change, `aim` stops colliding and the guard test below
// fails, saying so.
const TAG = { number: 0x4e4d, string: 0x5354, bigint: 0x4249, symbol: 0x5359, uniqueSymbol: 0x5553 } as const;

/** The `h` for which `mix(tag, h) === target`. */
const unmix = (tag: number, target: number): number => (((target ^ tag) >>> 0) - 0x9e3779b9 - (tag << 6) - (tag >>> 2)) >>> 0;

const out = { string: 0, number: 0 };
configureHasher({ string: () => out.string, number: () => out.number });

/**
 * From now on, everything the string hasher sees hashes to `target` as a
 * `stringsAs` leaf, and everything the number hasher sees as a `numbersAs`
 * leaf. (The string hasher also serves bigints and registered symbols, the
 * number hasher unique symbols: aim it as one of those and THEY land on the
 * target instead.) Values hashed under an earlier aim keep their cached
 * hashes, so a test uses values no earlier test has touched.
 */
function aim(target: number, stringsAs: number = TAG.string, numbersAs: number = TAG.number): void {
  out.string = unmix(stringsAs, target);
  out.number = unmix(numbersAs, target);
}

const EVERYTHING = 0x0c0111de;
aim(EVERYTHING);

const { OrderedMap } = await import('./ordered-map.js');
const { OrderedSet } = await import('./ordered-set.js');
const { ValueSet } = await import('./value-set.js');
const { ValueMap } = await import('./value-map.js');
const { intern, internHash } = await import('./intern.js');
const { deepEqual } = await import('./deep-equal.js');
const { memoize } = await import('./memoize.js');
const { produce, produceWithPatches } = await import('./produce.js');
const { expectPatchRoundTrip } = await import('./patches.test-helpers.js');

describe('the aim is true (a guard on this file’s own device)', () => {
  it('unmix inverts mix', () => {
    for (const tag of Object.values(TAG)) expect(mix(tag, unmix(tag, EVERYTHING))).toBe(EVERYTHING);
  });

  it('every string and every number share one full hash', () => {
    for (const leaf of ['', 'a', 'another', 0, 1, -2.5, NaN, Infinity]) expect(internHash(leaf), String(leaf)).toBe(EVERYTHING);
  });
});

describe('OrderedMap and OrderedSet when every key collides', () => {
  // One collision node holds every key, so every anchor update, insert and
  // delete goes through it, including the batched `trieSetLast`.
  it('a random walk agrees with an array model: content, positions, and the canonical instance', () => {
    const rnd = mulberry32(0x5eed);
    let m = OrderedMap.empty<string | number, number>();
    let s = OrderedSet.empty<string | number>();
    const model: [string | number, number][] = [];
    for (let step = 0; step < 1500; step++) {
      const r = rnd();
      const n = Math.floor(rnd() * 120);
      const key = n % 3 === 0 ? `s${n}` : n;
      const at = model.findIndex(([k]) => k === key);
      if (r < 0.45) {
        if (at >= 0) model[at] = [key, step];
        else model.push([key, step]);
        m = m.set(key, step);
        s = s.add(key);
      } else if (r < 0.75) {
        if (at >= 0) model.splice(at, 1);
        m = m.delete(key);
        s = s.delete(key);
      } else if (at < 0) {
        const i = Math.floor(rnd() * (model.length + 1));
        model.splice(i, 0, [key, step]);
        m = m.insertAt(i, key, step);
        s = s.insertAt(i, key);
      }
      if (step % 10 !== 0) continue;
      expect([...m]).toEqual(model);
      expect([...s]).toEqual(model.map(([k]) => k));
      model.forEach(([k, v], i) => {
        expect(m.indexOf(k)).toBe(i);
        expect(m.get(k)).toBe(v);
        expect(s.indexOf(k)).toBe(i);
      });
      expect(m).toBe(OrderedMap.from(model));
      expect(s).toBe(OrderedSet.from(model.map(([k]) => k)));
    }
  });

  it('a recipe’s patches replay and invert through the collision node', () => {
    const base = OrderedMap.from(Array.from({ length: 300 }, (_, i) => [i, i] as [number | string, number]));
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      for (let i = 0; i < 300; i += 7) d.delete(i);
      d.set(1000, 1);
      d.insertAt(3, 'x', 0);
      d.set(5, -5);
    });
    expect(next.size).toBe(300 - 43 + 2);
    expect(next.indexOf('x')).toBe(3);
    expectPatchRoundTrip(base, next, patches, inverse);
  });
});

describe('the intern pool when every hash collides', () => {
  // Same shape, same leaf kinds: one record hash for all of them, so the
  // pool's own comparison is all that tells them apart.
  it('equal content converges and different content stays apart, in one bucket', () => {
    const records = Array.from({ length: 200 }, (_, i) => intern({ id: i, tag: `t${i}` }));
    expect(new Set(records.map((r) => internHash(r))).size).toBe(1);
    expect(new Set(records).size).toBe(200);
    records.forEach((r, i) => expect(intern({ tag: `t${i}`, id: i })).toBe(r));
    expect(deepEqual(records[0], records[1])).toBe(false);
  });

  it('tells colliding candidates apart by element order, by key and by value; a null prototype is the same record', () => {
    expect(internHash([1, 2])).toBe(internHash([2, 1]));
    expect(intern([1, 2])).not.toBe(intern([2, 1]));
    expect(intern([1, 2])).toBe(intern([1, 2]));
    expect(intern({ a: 1 })).not.toBe(intern({ b: 1 }));
    expect(intern({ a: 1 })).not.toBe(intern({ a: 2 }));
    expect(intern({ a: 1 })).toBe(intern(Object.assign(Object.create(null), { a: 1 })));
  });

  it('a recipe\u2019s result is looked up among its collisions too: a hit, a different value, a different key', () => {
    const base = intern({ a: 1 }) as Record<string, number>;
    const taken = { value: intern({ a: 3 }), key: intern({ c: 1 }) };
    expect(internHash(taken.value)).toBe(internHash(base));
    expect(internHash(taken.key)).toBe(internHash(base));

    expect(produce(base, (d) => void (d['a'] = 3))).toBe(taken.value);
    const revalued = produce(base, (d) => void (d['a'] = 2));
    expect(revalued).toEqual({ a: 2 });
    expect(revalued).toBe(intern({ a: 2 }));
    const rekeyed = produce(base, (d) => {
      delete d['a'];
      d['b'] = 1;
    });
    expect(rekeyed).toEqual({ b: 1 });
    expect(rekeyed).not.toBe(taken.key);

    const list = intern([1, 2, 3]);
    const swapped = produce(list, (d) => void d.reverse());
    expect(internHash(swapped)).toBe(internHash(list));
    expect(swapped).toEqual([3, 2, 1]);
    expect(produce(swapped, (d) => void d.reverse())).toBe(list);
  });
});

describe('memoize when every argument list collides', () => {
  it('keeps colliding calls apart, and evicts the right one from a shared bucket', () => {
    let calls = 0;
    const f = memoize(
      (a: number, b: string) => {
        calls++;
        return `${a}:${b}`;
      },
      { maxSize: 4 },
    );
    const results = [0, 1, 2, 3].map((i) => f(i, `k${i}`)); // four entries, one bucket
    expect(results).toEqual(['0:k0', '1:k1', '2:k2', '3:k3']);
    expect(calls).toBe(4);
    expect(f.size).toBe(4);

    expect(f(2, 'k2')).toBe('2:k2'); // a hit from the middle of the bucket
    expect(calls).toBe(4);

    f(4, 'k4'); // evicts the least recently used: (0, 'k0')
    expect(f.size).toBe(4);
    expect(f(1, 'k1')).toBe('1:k1');
    expect(calls).toBe(5);
    expect(f(0, 'k0')).toBe('0:k0'); // gone, so it runs again
    expect(calls).toBe(6);

    // Down to one entry and back: the bucket collapses to a single and regrows.
    const g = memoize((a: number) => a * 2, { maxSize: 2 });
    expect([g(1), g(2), g(3), g(1)]).toEqual([2, 4, 6, 2]);
    expect(g.size).toBe(2);
    g.clear();
    expect(g.size).toBe(0);
    expect(g(1)).toBe(2);
  });

  it('a different number of arguments is a different call', () => {
    let calls = 0;
    const f = memoize((...xs: number[]) => (calls++, xs.length), { maxSize: 8 });
    expect([f(1), f(1, 1), f(1, 1, 1), f(1, 1)]).toEqual([1, 2, 3, 2]);
    expect(calls).toBe(3);
  });
});

// LAST in the file: each test re-aims the hasher, and values hashed before a
// re-aim keep their old hashes. Every value below is fresh to its test.
describe('collision nodes whose members are of different kinds', () => {
  // `memberCompare` orders a collision node by kind first, then within the
  // kind, and that order IS the canonical form: get it wrong between two
  // kinds and two builds of one set are two instances.
  const converges = (members: unknown[]): void => {
    const hashes = new Set(members.map((v) => internHash(v)));
    expect(hashes.size, 'the members do collide').toBe(1);
    const canonical = ValueSet.from(members);
    expect(canonical.size).toBe(members.length);
    for (let seed = 1; seed <= 12; seed++) {
      expect(ValueSet.from(shuffled(members, seed))).toBe(canonical);
      let chained = ValueSet.empty<unknown>();
      for (const v of shuffled(members, seed + 100)) chained = chained.add(v);
      expect(chained).toBe(canonical);
      expect([...chained]).toEqual([...canonical]);
    }
    for (const v of members) expect(canonical.has(v)).toBe(true);
    // Shrinking through the node keeps the form, down to one member and to none.
    let shrunk = canonical;
    const gone: unknown[] = [];
    for (const v of shuffled(members, 99)) {
      shrunk = shrunk.delete(v);
      gone.push(v);
      expect(shrunk).toBe(ValueSet.from(members.filter((x) => !gone.includes(x))));
    }
    expect(shrunk).toBe(ValueSet.empty());
    // …and as map keys, where an update inside the node must find its entry.
    let m = ValueMap.empty<unknown, number>();
    members.forEach((k, i) => (m = m.set(k, i)));
    m = m.set(members[0], -1);
    expect(m.get(members[0])).toBe(-1);
    members.slice(1).forEach((k, i) => expect(m.get(k)).toBe(i + 1));
  };

  it('strings with numbers', () => {
    aim(0x51a1e001);
    converges(['x1', 1.5, 'y1', -3, NaN, '', Infinity, 0]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['true', true],
    ['false', false],
  ])('%s, whose hash is fixed, with the strings and numbers aimed at it', (_name, fixed) => {
    aim(internHash(fixed));
    const tag = String(fixed);
    converges([`${tag}-a`, fixed, 7.25 + String(fixed).length, `${tag}-b`, -1 - String(fixed).length]);
  });

  it('bigints with numbers', () => {
    aim(0x51a1e002, TAG.bigint, TAG.number);
    converges([12n, 0.125, -12n, 99.5, 0n, 12.75]);
  });

  it('registered symbols with unique ones', () => {
    aim(0x51a1e003, TAG.symbol, TAG.uniqueSymbol);
    const registered = ['delta', 'alpha', 'charlie'].map((n) => Symbol.for(`valsem.collisions.${n}`));
    const unique = [Symbol('u1'), Symbol('u2'), Symbol('u3')];
    converges([unique[0], registered[0], unique[1], registered[1], registered[2], unique[2]]);
  });
});
