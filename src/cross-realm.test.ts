// ---------------------------------------------------------------------------
// Plain data from another realm — a `vm` context here; an iframe or jsdom in a
// browser or a test runner. Its records have that realm's Object.prototype,
// so the identity check `proto === Object.prototype` took them for instances
// of an unknown class named 'Object': deepEqual said false, intern threw.
// Arrays never had the problem (Array.isArray is realm-independent).
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { produce } from './produce.js';
import { HashMap } from './hash-map.js';
import { ValueMap } from './value-map.js';
import { memoize } from './memoize.js';

const realm = createContext({});
const foreign = <T>(source: string): T => runInContext(`(${source})`, realm) as T;
const SOURCE = '{ a: 1, b: [1, { c: 2 }], n: { deep: { x: [] } }, "__proto__x": null }';
type Shape = { a: number; b: [number, { c: number }]; n: { deep: { x: number[] } } };

describe('plain objects from another realm are plain records', () => {
  it('really are foreign: a different Object.prototype', () => {
    const f = foreign<object>(SOURCE);
    expect(Object.getPrototypeOf(f)).not.toBe(Object.prototype);
    expect(f instanceof Object).toBe(false);
  });

  it('compare, hash and intern like local ones, and converge on one canonical', () => {
    const f = foreign<Shape>(SOURCE);
    const local = (0, eval)(`(${SOURCE})`) as Shape;
    expect(deepEqual(f, local)).toBe(true);
    expect(deepEqual(local, f)).toBe(true);
    expect(deepHash(f)).toBe(deepHash(local));
    const canonical = intern(f);
    expect(canonical).toBe(intern(local));
    // The canonical is rebuilt in THIS realm, all the way down.
    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(canonical.n.deep)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(canonical.b)).toBe(Array.prototype);
    expect(deepEqual(f, { ...local, a: 2 })).toBe(false);
  });

  it('as a produce base, a graft, a key and a memoize argument', () => {
    const f = foreign<Shape>(SOURCE);
    const next = produce(f, (d) => {
      d.a = 2;
      d.n.deep.x.push(1);
    });
    expect(next.a).toBe(2);
    expect(next.n.deep.x).toEqual([1]);
    expect(produce(intern({ slot: null as unknown }), (d) => void (d.slot = f)).slot).toBe(intern(f));

    const m = new HashMap<unknown, string>();
    m.set({ k: [1] }, 'v');
    expect(m.get(foreign('{ k: [1] }'))).toBe('v');
    expect(ValueMap.from([[foreign('{ k: 1 }'), 1]]).get({ k: 1 })).toBe(1);

    let calls = 0;
    const f1 = memoize((o: { k: number }) => (calls++, o.k));
    f1({ k: 7 });
    f1(foreign('{ k: 7 }'));
    expect(calls).toBe(1);
  });

  it('only PLAIN objects: a foreign class instance, Date, Map or a forged prototype is still not a value', () => {
    expect(() => intern(foreign('new (class Foo { constructor() { this.a = 1; } })()'))).toThrow(/Foo/);
    expect(() => intern(foreign('new Date(0)'))).toThrow();
    expect(() => intern(foreign('new Map()'))).toThrow();
    expect(deepEqual(foreign('new Date(0)'), foreign('new Date(0)'))).toBe(false);
    // Looks like an Object.prototype, but its constructor does not point back at it.
    const forged = Object.create(Object.create(null, { constructor: { value: function Object() {} } })) as object;
    expect(() => intern(forged)).toThrow();
    expect(deepEqual(forged, {})).toBe(false);
  });
});

describe('a registered hash handler is normalised like [hashCode]', () => {
  it('any number it returns becomes a uint32', () => {
    class K {
      constructor(readonly n: number) {}
    }
    deepEqual.register(K, (a, b) => a.n === b.n, () => -8.5);
    const h = deepHash(new K(1));
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
    expect(h).toBe(-8.5 >>> 0);
    expect(intern(new K(1))).toBe(intern(new K(1)));
    expect(intern(new K(1))).not.toBe(intern(new K(2)));
  });
});
