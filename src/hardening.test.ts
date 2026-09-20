// ---------------------------------------------------------------------------
// Hardening: prototype pollution through every entry point an untrusted
// input can reach, forged canonicality, what a sparse array means, and
// constructor shadowing.
// ---------------------------------------------------------------------------
import { describe, it, expect, afterEach } from 'vitest';
import { intern, isCanonical, fastEquals } from './intern.js';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { produce, produceWithPatches, applyPatches, type Patch } from './produce.js';
import { current } from './current.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';
import { withPolluted } from './pollution.test-helpers.js';

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
    withPolluted(Array.prototype, 1, 'LEAK', () => {
      const c = intern({ a: 1, b: undefined, c: 3 });
      expect(Object.hasOwn(c, 'b')).toBe(false);
      expect(c).toBe(intern({ a: 1, c: 3 }));
    });
  });
});

describe('a sparse array is the dense array with undefined in its holes', () => {
  // One meaning, everywhere: every walk reads `arr[i]`, so equality, hashing
  // and interning cannot disagree about what an array contains. (An earlier
  // design had intern, RawArray and ValueList.from check own slots while
  // deepEqual and deepHash did not; they could then only agree while no
  // built-in prototype carried an index property. That case is outside the
  // threat model — see D44 — and the checks are gone.)
  const sparse = (): unknown[] => {
    const a: unknown[] = [1];
    a.length = 4;
    a[3] = 4;
    return a; // [1, <hole>, <hole>, 4]
  };
  const DENSE = [1, undefined, undefined, 4];

  it('intern, deepEqual and deepHash agree', () => {
    const c = intern(sparse());
    expect(c).toBe(intern(DENSE));
    expect(deepEqual(sparse(), c)).toBe(true);
    expect(deepEqual(sparse(), DENSE)).toBe(true);
    expect(deepEqual(sparse(), sparse())).toBe(true);
    expect(deepHash(sparse())).toBe(deepHash(c));
    expect(deepHash(sparse())).toBe(deepHash(DENSE));
    expect(deepEqual({ a: [sparse()] }, { a: [DENSE] })).toBe(true);
  });

  it('a canonical array is dense: every index is an own property', () => {
    const results: (readonly unknown[])[] = [
      intern(sparse()),
      produce(sparse(), () => {}),
      produce(sparse(), (d) => void d.push(5)),
      produce(intern([1] as unknown[]), (d) => void (d.length = 4)),
      produce(intern([1] as unknown[]), (d) => void (d[3] = 4)),
      produce(intern({ x: null as unknown }), (d) => void (d.x = sparse())).x as unknown[],
    ];
    for (const r of results) {
      expect(Object.isFrozen(r)).toBe(true);
      for (let i = 0; i < r.length; i++) expect(Object.hasOwn(r, i)).toBe(true);
    }
    expect(results[3]).toBe(intern([1, undefined, undefined, undefined]));
    expect(results[4]).toBe(intern(DENSE));
  });

  it('through the collections too', () => {
    expect([...ValueList.from(sparse())]).toEqual(DENSE);
    expect(ValueList.from(sparse())).toBe(ValueList.from(DENSE));
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

describe('applyPatches says what is wrong with a malformed patch list', () => {
  const base = intern({ a: 1 });
  const apply = (patches: unknown): unknown => applyPatches(base, patches as Patch[]);

  it('what is not a list of patches', () => {
    for (const bad of [null, undefined, 5, 'abc', {}]) {
      expect(() => apply(bad)).toThrow(/^valsem: applyPatches expects a list of patches, got /);
    }
    expect(() => apply({ kind: 'record.set', path: [], key: 'a', value: 2 })).toThrow(/a single 'record.set' patch — wrap it in an array/);
  });

  it('what is not a patch, by its index, before anything is applied', () => {
    const good = { kind: 'record.set', path: [], key: 'a', value: 2 };
    for (const bad of [null, undefined, 5, 'x', [], {}, { path: [] }, { kind: 1, path: [] }, { kind: 'record.set' }, { kind: 'record.set', path: 'a' }]) {
      expect(() => apply([good, bad])).toThrow(/^valsem: malformed patch at index 1 — expected an object with a `kind` string and a `path` array/);
    }
    for (const bad of [null, 'abc', [[]], [null]]) expect(() => apply(bad)).toThrow(TypeError);
  });

  it('a payload of the wrong type for its kind, named by kind', () => {
    expect(() => apply([{ kind: 'record.set', path: [], key: 5, value: 1 }])).toThrow(/malformed 'record\.set' patch — expected a string or symbol key/);
    expect(() => apply([{ kind: 'record.delete', path: [], key: null }])).toThrow(/malformed 'record\.delete' patch — expected a string or symbol key/);
    const members = OrderedSet.of('a', 'b');
    for (const index of [0.5, '1', null, NaN]) {
      expect(() => applyPatches(members, [{ kind: 'oset.insert', path: [], index, value: 'z' } as unknown as Patch])).toThrow(/malformed 'oset\.insert' patch — expected an integer index/);
    }
    expect(base).toBe(intern({ a: 1 }));
  });

  it('a path that ends at what is no record: refused by valsem, not by the engine', () => {
    // A stale path is the ordinary way to get here: the map key is gone, the
    // list is shorter, the slot now holds a number. record.set and
    // record.delete were the two kinds that did not look before they wrote,
    // and the caller got "Cannot set properties of undefined".
    const holders: [string, unknown, PropertyKey, PropertyKey][] = [
      ['record', intern({ rec: { x: 1 }, n: 5 }), 'n', 'gone'],
      ['array', intern([{ x: 1 }, 5]), 1, 9],
      ['ValueMap', ValueMap.from<string, unknown>([['rec', { x: 1 }], ['n', 5]]), 'n', 'gone'],
      ['OrderedMap', OrderedMap.from<string, unknown>([['rec', { x: 1 }], ['n', 5]]), 'n', 'gone'],
      ['ValueList', ValueList.of<unknown>({ x: 1 }, 5), 1, 9],
    ];
    for (const [name, holder, atPrimitive, atNothing] of holders) {
      for (const at of [atPrimitive, atNothing]) {
        for (const patch of [
          { kind: 'record.set', path: [at], key: 'k', value: 1 },
          { kind: 'record.delete', path: [at], key: 'k' },
        ]) {
          expect(() => applyPatches(holder, [patch as Patch]), `${name} ${String(at)} ${patch.kind}`).toThrow(
            /^valsem: (cannot apply a 'record\.(set|delete)' patch to a |patch path segment )/,
          );
        }
      }
    }
    // A null slot likewise, and a stored undefined (a value, in a map) is still no record.
    expect(() => applyPatches(intern({ slot: null }), [{ kind: 'record.set', path: ['slot'], key: 'k', value: 1 }])).toThrow(/patch to a null/);
    const holdsUndefined = ValueMap.from<string, unknown>([['u', undefined]]);
    expect(() => applyPatches(holdsUndefined, [{ kind: 'record.set', path: ['u'], key: 'k', value: 1 }])).toThrow(/value that is not there/);
  });

  it('any iterable of patches will do', () => {
    const patches = new Set([{ kind: 'record.set', path: [], key: 'a', value: 2 }]);
    expect(apply(patches)).toBe(intern({ a: 2 }));
  });
});

describe('a patch applies to its own kind of value and to no other', () => {
  // A patch list replayed against the wrong state is the ordinary failure
  // (a stale client, two documents crossed), and the dangerous outcome is a
  // patch that "applies": `list.set` once wrote the key "0" onto a record.
  // So: one GENUINE patch of every kind, recorded from a real recipe, against
  // every kind of target, at the root and one level down.
  const targets: Record<string, unknown> = {
    record: intern({ a: 1, b: 2 }),
    array: intern([1, 2, 3]),
    ValueList: ValueList.of(1, 2, 3),
    ValueMap: ValueMap.from([['a', 1], ['b', 2]]),
    ValueSet: ValueSet.from(['a', 'b']),
    OrderedMap: OrderedMap.from([['a', 1], ['b', 2]]),
    OrderedSet: OrderedSet.of('a', 'b'),
  };
  // `any`: one recipe per target kind, each written against that kind's own draft.
  const recipes: Record<string, (d: any) => void> = {
    record: (d) => { d.a = 9; delete d.b; },
    array: (d) => { d[0] = 9; d.push(4); },
    ValueList: (d) => { d.set(0, 9); d.push(4); },
    ValueMap: (d) => { d.set('a', 9); d.delete('b'); },
    ValueSet: (d) => { d.add('c'); d.delete('a'); },
    OrderedMap: (d) => { d.set('a', 9); d.delete('b'); d.insertAt(0, 'z', 1); },
    OrderedSet: (d) => { d.add('c'); d.delete('a'); d.insertAt(0, 'z'); },
  };
  // The one family with two members: a sequence patch fits either sequence.
  const family = (name: string): string => (name === 'array' || name === 'ValueList' ? 'sequence' : name);

  const genuine = new Map<string, { from: string; patch: Patch }>();
  for (const [from, base] of Object.entries(targets)) {
    for (const patch of produceWithPatches(base, recipes[from]!)[1]) if (!genuine.has(patch.kind)) genuine.set(patch.kind, { from, patch });
  }

  it('the recipes between them record every kind of patch there is', () => {
    expect([...genuine.keys()].sort()).toEqual([
      'list.set', 'list.splice',
      'map.delete', 'map.set',
      'omap.delete', 'omap.insert', 'omap.set',
      'oset.add', 'oset.delete', 'oset.insert',
      'record.delete', 'record.set',
      'set.add', 'set.delete',
    ]);
  });

  const cases = [...genuine].flatMap(([kind, { from, patch }]) => Object.keys(targets).map((onto) => [kind, from, onto, patch] as const));

  it.each(cases)('%s (recorded on a %s) onto a %s', (kind, from, onto, patch) => {
    const base = targets[onto];
    const nested = intern({ held: base });
    const below = { ...patch, path: ['held', ...patch.path] } as Patch;
    if (family(from) === family(onto)) {
      expect(applyPatches(base, [patch])).not.toBe(base);
      expect((applyPatches(nested, [below]) as { held: unknown }).held).toBe(applyPatches(base, [patch]));
      return;
    }
    // Says which patch and what it met; "arrays take integer indices" is the
    // array draft's own refusal of a record.set, which never gets as far.
    const refusal = new RegExp(`cannot apply a '${kind.replace('.', '\\.')}' patch to |arrays take integer indices`);
    expect(() => applyPatches(base, [patch])).toThrow(refusal);
    expect(() => applyPatches(nested, [below])).toThrow(refusal);
  });
});
