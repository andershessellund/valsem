// ---------------------------------------------------------------------------
// Sparse arrays under prototype pollution.
//
// An array's value is its length and its OWN elements, a hole meaning
// `undefined`. JavaScript's `arr[i]` is not that: on a hole it reads the
// prototype chain, and `slice`, spread, `Array.from`, `concat` and the array
// iterator do the same. `intern` always read own slots; `deepEqual`,
// `deepHash`, produce's graft path, RawArray and the collections' `from` did
// not (external review). With `Array.prototype[1] = x` the canonical form of
// a sparse array stopped being equal to the array, and — through a graft, a
// replacement, a patch value or a raw sparse base — `x` itself entered
// canonical state. valsem promises that prototype pollution cannot reach a
// value; these pin it for arrays.
//
// Each case computes under pollution and asserts after it is lifted: the
// assertion library reads arrays too.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { produce, produceWithPatches, applyPatches } from './produce.js';
import { current } from './current.js';
import { memoize } from './memoize.js';
import { HashMap } from './hash-map.js';
import { HashSet } from './hash-set.js';
import { RawArray } from './raw-array.js';
import { ValueList } from './value-list.js';
import { ValueSet } from './value-set.js';
import { ValueMap } from './value-map.js';
import { OrderedSet } from './ordered-set.js';
import { OrderedMap } from './ordered-map.js';

const EVIL = Object.freeze({ evil: true });

/** Run `f` with every small index polluted on Array.prototype AND Object.prototype. */
function polluted<T>(f: () => T): T {
  const protos = [Array.prototype, Object.prototype] as unknown as Record<number, unknown>[];
  for (const p of protos) for (let i = 0; i < 16; i++) Object.defineProperty(p, i, { value: EVIL, configurable: true, writable: true, enumerable: true });
  try {
    return f();
  } finally {
    for (const p of protos) for (let i = 0; i < 16; i++) delete p[i];
  }
}

/** `[1, <hole>, <hole>]` */
const sparse = (): unknown[] => {
  const a: unknown[] = [1];
  a.length = 3;
  return a;
};
/** `['k', <hole>]` */
const sparseEntry = (): [string, unknown] => {
  const t = ['k'] as unknown as [string, unknown];
  t.length = 2;
  return t;
};
const DENSE = [1, undefined, undefined];
const hasEvil = (v: unknown): boolean => JSON.stringify(v, (_k, x: unknown) => (x === EVIL ? 'EVIL' : x))?.includes('EVIL') ?? false;

describe('the premise', () => {
  it('a hole reads the prototype chain, and so do the native copies', () => {
    const seen = polluted(() => ({ read: sparse()[1], slice: sparse().slice()[1], spread: [...sparse()][1], from: Array.from(sparse())[1] }));
    expect(seen).toEqual({ read: EVIL, slice: EVIL, spread: EVIL, from: EVIL });
  });
});

describe('a sparse array means the same to every part of valsem', () => {
  it('intern, deepEqual and deepHash agree, polluted or not', () => {
    for (const run of [<T>(f: () => T): T => f(), polluted]) {
      const r = run(() => {
        const canonical = intern(sparse());
        return {
          canonical,
          isDense: canonical === intern(DENSE),
          equalsItsCanonical: deepEqual(sparse(), canonical) && deepEqual(canonical, sparse()),
          equalsDense: deepEqual(sparse(), DENSE) && deepEqual(DENSE, sparse()),
          twoSparse: deepEqual(sparse(), sparse()),
          hash: deepHash(sparse()) === deepHash(canonical) && deepHash(sparse()) === deepHash(DENSE),
          nested: deepEqual({ a: [sparse()] }, { a: [DENSE] }) && deepHash({ a: [sparse()] }) === deepHash({ a: [DENSE] }),
          notEqualToEvil: deepEqual(sparse(), [1, EVIL, EVIL]),
        };
      });
      expect(r.canonical).toEqual(DENSE);
      expect(hasEvil(r.canonical)).toBe(false);
      expect(r).toMatchObject({ isDense: true, equalsItsCanonical: true, equalsDense: true, twoSparse: true, hash: true, nested: true, notEqualToEvil: false });
    }
  });

  it('as a key and as a memoize argument', () => {
    const r = polluted(() => {
      const m = new HashMap<unknown, string>();
      m.set(intern(DENSE), 'hit');
      let calls = 0;
      const f = memoize((a: unknown[]) => (calls++, a.length));
      f(sparse());
      f(DENSE);
      return { get: m.get(sparse()), calls };
    });
    expect(r).toEqual({ get: 'hit', calls: 1 });
  });
});

describe('pollution cannot enter canonical state through an array', () => {
  const cases: [string, () => unknown][] = [
    ['intern', () => intern({ deep: [sparse()] })],
    ['a graft', () => produce(intern({}) as Record<string, unknown>, (d) => void (d.x = sparse()))],
    ['a nested graft', () => produce(intern({}) as Record<string, unknown>, (d) => void (d.x = { a: [sparse()] }))],
    ['a returned replacement', () => produce(intern({}) as unknown, () => ({ r: sparse() }))],
    ['a raw sparse base, untouched', () => produce(sparse(), () => {})],
    ['a raw sparse base, edited', () => produce(sparse(), (d) => void d.push(9))],
    ['a raw sparse base inside a raw record', () => produce({ l: sparse() }, (d) => void d.l.push(9))],
    ['a draft grown by length', () => produce(intern({ l: [1] as unknown[] }), (d) => void (d.l.length = 3))],
    ['a draft grown by a far index', () => produce(intern({ l: [1] as unknown[] }), (d) => void (d.l[3] = 9))],
    ['an out-of-range draft read, stored', () => produce(intern({ l: [1] as unknown[], got: null as unknown }), (d) => void (d.got = d.l[5]))],
    ['current()', () => { let snap: unknown; produce(intern({}) as Record<string, unknown>, (d) => { d.x = sparse(); snap = current(d); }); return snap; }],
    ['a patch value', () => applyPatches(intern({}), [{ kind: 'record.set', path: [], key: 'l', value: sparse() }])],
    ['a list.splice patch insert', () => applyPatches(intern({ l: [0] }), [{ kind: 'list.splice', path: ['l'], index: 1, remove: 0, insert: sparse() }])],
    ['a list.splice patch into a ValueList', () => [...applyPatches(ValueList.of<unknown>(0), [{ kind: 'list.splice', path: [], index: 1, remove: 0, insert: sparse() }])]],
    ['RawArray.slice', () => RawArray.from(sparse()).slice()],
    ['RawArray.get', () => [RawArray.from(sparse()).get(1), RawArray.from(sparse()).get(7)]],
    ['ValueList.from', () => [...ValueList.from(sparse())]],
    ['ValueList.splice items', () => [...ValueList.of<unknown>(0).splice(1, 0, sparse())]],
    ['ValueSet.from', () => [...ValueSet.from(sparse())]],
    ['OrderedSet.from', () => [...OrderedSet.from(sparse())]],
    ['HashSet.from', () => [...HashSet.from(sparse())]],
    ['ValueMap.from, a sparse entry', () => [...ValueMap.from([sparseEntry()])]],
    ['OrderedMap.from, a sparse entry', () => [...OrderedMap.from([sparseEntry()])]],
    ['HashMap.from, a sparse entry', () => [...HashMap.from([sparseEntry()])]],
    ['a collection value', () => ValueMap.from([['k', sparse()]]).get('k')],
  ];

  it.each(cases)('%s', (_name, compute) => {
    const dirty = polluted(compute);
    expect(hasEvil(dirty)).toBe(false);
    // …and pollution changes nothing at all: the same computation, clean, is the same value.
    expect(intern(dirty)).toBe(intern(compute()));
  });

  it('patches from a recipe that grows an array carry no pollution either', () => {
    const [result, patches, inverse] = polluted(() => produceWithPatches(intern({ l: [1] as unknown[] }), (d) => void (d.l.length = 3)));
    expect(result).toBe(intern({ l: DENSE }));
    expect(hasEvil(patches) || hasEvil(inverse)).toBe(false);
    expect(applyPatches(intern({ l: [1] }), patches)).toBe(result);
  });
});

describe("valsem's own arrays are not read through the prototype chain either", () => {
  // Found by running the whole suite polluted (pnpm test:polluted), not by
  // inspection: `new Array(32)` read before written in the trie builder, and
  // the sparse `carry` of ValueList's batch rebuild. With an ARRAY as the
  // polluted value, both would have pushed into one shared array, silently.
  it('building and batch-editing collections', () => {
    const r = polluted(() => {
      const set = ValueSet.from(Array.from({ length: 200 }, (_, i) => i));
      const map = ValueMap.from(Array.from({ length: 200 }, (_, i) => [`k${i}`, i] as [string, number]));
      const list = ValueList.from(Array.from({ length: 2000 }, (_, i) => i)).setMany([[3, -3], [700, -700], [1999, -1999]]);
      const viaDraft = produce(ValueList.from(Array.from({ length: 2000 }, (_, i) => i)), (d) => { d.set(3, -3); d.set(700, -700); d.set(1999, -1999); });
      return { setSize: set.size, has: set.has(150), mapGet: map.get('k150'), l3: list.get(3), l700: list.get(700), len: list.length, same: list === viaDraft };
    });
    expect(r).toEqual({ setSize: 200, has: true, mapGet: 150, l3: -3, l700: -700, len: 2000, same: true });
  });
});
