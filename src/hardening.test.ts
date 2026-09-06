// ---------------------------------------------------------------------------
// Hardening: prototype pollution through every entry point an untrusted
// input can reach, forged canonicality, holes under a polluted
// Array.prototype, and constructor shadowing.
// ---------------------------------------------------------------------------
import { describe, it, expect, afterEach } from 'vitest';
import { intern, isCanonical, fastEquals } from './intern.js';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { produce, applyPatches, type Patch } from './produce.js';
import { current } from './current.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';

const clean = (): void => {
  delete (Object.prototype as Record<string, unknown>)['polluted'];
  delete (Array.prototype as unknown as Record<string, unknown>)['polluted'];
  delete (Array.prototype as unknown as Record<number, unknown>)[0];
  delete (Array.prototype as unknown as Record<number, unknown>)[1];
};
afterEach(clean);
const unpolluted = (): void => {
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(([] as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
};

describe('applyPatches — hostile paths and keys cannot reach a prototype', () => {
  const base = intern({ a: 1, nested: { b: 2 }, arr: [1, 2] });
  it('rejects a path through __proto__ or constructor', () => {
    for (const path of [['__proto__'], ['constructor', 'prototype'], ['nested', '__proto__'], ['toString'], ['arr', '__proto__']]) {
      expect(() => applyPatches(base, [{ kind: 'record.set', path, key: 'polluted', value: 1 } as Patch])).toThrow(/does not address an own key or index/);
    }
    unpolluted();
  });
  it('rejects non-existent and out-of-range segments', () => {
    expect(() => applyPatches(base, [{ kind: 'record.set', path: ['missing'], key: 'x', value: 1 }])).toThrow(/does not address/);
    expect(() => applyPatches(base, [{ kind: 'list.set', path: ['arr', 5], index: 0, value: 1 } as Patch])).toThrow(/does not address/);
    expect(() => applyPatches(base, [{ kind: 'list.set', path: ['arr', '1'], index: 0, value: 1 } as Patch])).toThrow(/does not address/);
    expect(() => applyPatches(base, [{ kind: 'record.set', path: ['a', 'x'], key: 'x', value: 1 }])).toThrow(/does not address/);
  });
  it('a __proto__ key in a record.set becomes an own key, on drafts and on raw material alike', () => {
    const next = applyPatches(base, [{ kind: 'record.set', path: [], key: '__proto__', value: { polluted: 1 } }]);
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    const viaRaw = applyPatches(base, [
      { kind: 'record.set', path: [], key: 'nested', value: { raw: 1 } },
      { kind: 'record.set', path: ['nested'], key: '__proto__', value: { polluted: 2 } },
    ]);
    expect(Object.hasOwn(viaRaw.nested, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(viaRaw.nested)).toBe(Object.prototype);
    unpolluted();
  });
  it('a malformed list.set index is rejected on a drafted array', () => {
    expect(() => applyPatches(base, [{ kind: 'list.set', path: ['arr'], index: '__proto__', value: { polluted: 3 } } as unknown as Patch])).toThrow();
    unpolluted();
  });
  it('malformed list patches on raw arrays throw', () => {
    expect(() =>
      applyPatches(base, [
        { kind: 'record.set', path: [], key: 'arr', value: [9] },
        { kind: 'list.set', path: ['arr'], index: '__proto__', value: { polluted: 4 } } as unknown as Patch,
      ]),
    ).toThrow(/malformed 'list.set' patch/);
    expect(() => applyPatches(base, [{ kind: 'list.splice', path: ['arr'], index: 0, remove: -1, insert: [] }])).toThrow(/malformed/);
    expect(() => applyPatches(base, [{ kind: 'list.splice', path: ['arr'], index: 0, remove: 0, insert: 'x' } as unknown as Patch])).toThrow(/malformed/);
    unpolluted();
  });
});

describe('JSON with __proto__ and constructor keys is data everywhere', () => {
  const j = (): Record<string, unknown> => JSON.parse('{"__proto__":{"polluted":5},"constructor":{"prototype":{"polluted":6}},"a":1}') as Record<string, unknown>;
  it('intern, produce, current, ValueMap.fromObject, HashMap, memoize', () => {
    const c = intern(j());
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.hasOwn(c, '__proto__')).toBe(true);
    produce(intern({ a: 1 }), (d) => Object.assign(d, j()));
    produce(intern({ a: 1 }), (d) => void ((d as Record<string, unknown>)['__proto__'] = { polluted: 7 }));
    produce(intern(j()), (d) => void current(d));
    ValueMap.fromObject(j());
    new HashMap<object, number>().set(j(), 1);
    memoize((o: object) => o)(j());
    unpolluted();
    expect(deepEqual(j(), j())).toBe(true);
    expect(deepHash(j())).toBe(deepHash(j()));
  });
});

describe('holes and a polluted Array.prototype', () => {
  it('an undefined-valued key stays absent even with Array.prototype[i] set', () => {
    (Array.prototype as unknown as Record<number, unknown>)[1] = 'LEAK';
    const c = intern({ a: 1, b: undefined, c: 3 });
    expect(Object.hasOwn(c, 'b')).toBe(false);
    expect(c).toBe(intern({ a: 1, c: 3 }));
  });
  it('a holey input array canonicalises with undefined, not the prototype value', () => {
    (Array.prototype as unknown as Record<number, unknown>)[0] = 'LEAK';
    const c = intern([, 2] as unknown[]);
    expect(c[0]).toBeUndefined();
    expect(Object.hasOwn(c, 0)).toBe(true);
    expect(c).toBe(intern([undefined, 2]));
    expect(ValueList.from([, 2] as unknown[]).get(0)).toBeUndefined();
  });
});

describe('protocol symbols are ordinary keys on plain records', () => {
  it('an own [interned] on a record does not forge canonicality', () => {
    const o = { x: 1, [interned]: true } as Record<string | symbol, unknown>;
    expect(isCanonical(o)).toBe(false);
    const c = intern(o);
    expect(c).not.toBe(o);
    expect(Object.isFrozen(c)).toBe(true);
    expect(c[interned]).toBe(true); // it is a key of the value
    expect(intern({ [interned]: true, x: 1 })).toBe(c);
    expect(deepEqual(o, { x: 1 })).toBe(false); // the symbol key is part of the content
    expect(() => fastEquals(o, o)).toThrow(/raw object/);
  });
  it('an own [hashCode] or [equals] on a record is a key, not the protocol', () => {
    const a = { x: 1, [hashCode]: 42 } as Record<string | symbol, unknown>;
    const b = { x: 2, [hashCode]: 42 } as Record<string | symbol, unknown>;
    expect(deepHash(a)).not.toBe(42);
    expect(deepHash(a)).not.toBe(deepHash(b));
    const e = { x: 1, [equals]: () => true } as Record<string | symbol, unknown>;
    expect(() => deepHash(e)).toThrow(/function/); // a function value is not a value
    expect(deepEqual({ x: 1, [equals]: 1 }, { x: 2, [equals]: 1 })).toBe(false);
  });
  it('class instances keep the protocol, own field or prototype getter alike', () => {
    class Own {
      [hashCode] = 7;
      [interned] = true;
      constructor(readonly v: number) {}
      [equals](o: unknown): boolean {
        return o instanceof Own && o.v === this.v;
      }
    }
    expect(deepHash(new Own(1))).toBe(7);
    expect(isCanonical(new Own(1))).toBe(true);
    expect(deepEqual(new Own(1), new Own(1))).toBe(false); // marked ⟹ non-identical is unequal, by contract
  });
});

describe('constructor shadowing', () => {
  it('an own `constructor` string key is just data', () => {
    const fake = JSON.parse('{"constructor":"Date","a":1}') as Record<string, unknown>;
    expect(intern(fake)).toBe(intern({ a: 1, constructor: 'Date' }));
    expect(deepEqual(fake, { a: 1, constructor: 'Date' })).toBe(true);
  });
});

describe('deepEqual on cyclic raw input throws rather than hanging', () => {
  it('RangeError', () => {
    const a: Record<string, unknown> = { n: 1 };
    a['self'] = a;
    const b: Record<string, unknown> = { n: 1 };
    b['self'] = b;
    expect(() => deepEqual(a, b)).toThrow(RangeError);
  });
});
