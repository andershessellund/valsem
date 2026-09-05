// ---------------------------------------------------------------------------
// Symbols are values — as values and as record keys.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { deepEqual, equals, hashCode, interned } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { HashMap } from './hash-map.js';
import { ValueSet } from './value-set.js';
import { ValueMap } from './value-map.js';
import { produce, produceWithPatches, applyPatches, toDraft } from './produce.js';
import { current } from './current.js';
import { DRAFT_STATE } from './draft.js';

const reg = Symbol.for('valsem.test.reg');
const uniq = Symbol('uniq');
const other = Symbol('uniq'); // same description, different identity

describe('symbols as values', () => {
  it('registered symbols hash by name; unique ones by identity', () => {
    expect(deepHash(reg)).toBe(deepHash(Symbol.for('valsem.test.reg')));
    expect(deepHash(uniq)).toBe(deepHash(uniq)); // stable across calls
    expect(deepHash(uniq)).not.toBe(deepHash(other)); // same description is not the same symbol
    expect(deepHash(Symbol.iterator)).toBe(deepHash(Symbol.iterator)); // well-known: identity path
    expect(deepHash(reg)).not.toBe(deepHash('valsem.test.reg')); // tagged apart from its name
  });

  it('equality is identity, which is what registered symbols already share', () => {
    expect(deepEqual(reg, Symbol.for('valsem.test.reg'))).toBe(true);
    expect(deepEqual(uniq, other)).toBe(false);
    expect(deepEqual({ k: uniq }, { k: uniq })).toBe(true);
    expect(deepEqual([reg], [Symbol.for('valsem.test.reg')])).toBe(true);
  });

  it('works wherever a value does: HashMap keys, set members, map keys, records, drafts', () => {
    const m = new HashMap<unknown, string>();
    m.set(uniq, 'u');
    m.set(reg, 'r');
    expect(m.get(uniq)).toBe('u');
    expect(m.get(other)).toBeUndefined();
    expect(m.get(Symbol.for('valsem.test.reg'))).toBe('r');
    expect(ValueSet.from([uniq, reg])).toBe(ValueSet.from([Symbol.for('valsem.test.reg'), uniq]));
    expect(ValueMap.from([[uniq, 1]]).get(uniq)).toBe(1);
    expect(intern({ kind: uniq })).toBe(intern({ kind: uniq }));
    expect(produce(intern({ kind: reg }), (d) => void (d.kind = uniq))).toBe(intern({ kind: uniq }));
  });
});

describe('symbol keys in records', () => {
  it('are part of the value: equality sees them', () => {
    expect(deepEqual({ [uniq]: 1 }, { [uniq]: 2 })).toBe(false);
    expect(deepEqual({ [uniq]: 1 }, { [uniq]: 1 })).toBe(true);
    expect(deepEqual({ [uniq]: 1 }, {})).toBe(false);
    expect(deepEqual({}, { [uniq]: 1 })).toBe(false);
    expect(deepEqual({ [uniq]: 1 }, { [other]: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { [Symbol.for('a')]: 1 })).toBe(false); // a symbol key is not its name
    expect(deepEqual({ a: 1, [uniq]: 2 }, { [uniq]: 2, a: 1 })).toBe(true); // order-independent
    expect(deepEqual({ [uniq]: 1, [reg]: 2 }, { [reg]: 2, [uniq]: 1 })).toBe(true);
  });

  it('hash: order-independent, key-sensitive, and distinct from the string key of the same name', () => {
    expect(deepHash({ a: 1, [uniq]: 2 })).toBe(deepHash({ [uniq]: 2, a: 1 }));
    expect(deepHash({ [uniq]: 1 })).not.toBe(deepHash({ [other]: 1 }));
    expect(deepHash({ a: 1 })).not.toBe(deepHash({ [Symbol.for('a')]: 1 }));
    expect(deepHash({ [uniq]: 1 })).not.toBe(deepHash({}));
  });

  it('follow record semantics: undefined-valued and non-enumerable symbol keys are absent', () => {
    expect(deepEqual({ [uniq]: undefined }, {})).toBe(true);
    expect(deepHash({ [uniq]: undefined })).toBe(deepHash({}));
    const hidden = Object.defineProperty({ a: 1 }, uniq, { value: 'x', enumerable: false });
    expect(deepEqual(hidden, { a: 1 })).toBe(true);
    expect(Object.getOwnPropertySymbols(intern(hidden))).toEqual([]);
  });

  it('intern keeps them, canonicalises regardless of insertion order, and lays them out deterministically', () => {
    const a = intern({ z: 1, [uniq]: 'u', [reg]: 'r', a: 2 });
    const b = intern({ [reg]: 'r', a: 2, [uniq]: 'u', z: 1 });
    expect(a).toBe(b);
    expect(a[uniq]).toBe('u');
    expect(a[reg]).toBe('r');
    expect(Object.keys(a)).toEqual(['a', 'z']);
    expect(Reflect.ownKeys(a)).toEqual(['a', 'z', reg, uniq]); // strings sorted, registered before unique
    expect(Object.isFrozen(a)).toBe(true);
    expect(intern({ [uniq]: undefined, a: 1 })).toBe(intern({ a: 1 }));
    expect(intern({ [uniq]: { n: 1 } })[uniq]).toBe(intern({ n: 1 })); // values canonical too
  });

  it('nested and in collections', () => {
    const s = ValueSet.from([{ [uniq]: 1 }, { [uniq]: 1 }]);
    expect(s.size).toBe(1);
    expect(s.has({ [uniq]: 1 })).toBe(true);
    const m = new HashMap<object, number>();
    m.set({ [uniq]: [1, { [reg]: 2 }] }, 5);
    expect(m.get({ [uniq]: [1, { [Symbol.for('valsem.test.reg')]: 2 }] })).toBe(5);
  });
});

describe('symbol keys on record drafts', () => {
  const base = intern({ a: 1, [uniq]: { n: 1 }, [reg]: 'r' });

  it('read, write, delete, add, and draft through them', () => {
    const next = produce(base, (d) => {
      expect(d[reg]).toBe('r');
      d[uniq].n = 2; // drafted through a symbol key
      d[reg] = 's';
      delete (d as Record<symbol, unknown>)[reg];
      (d as Record<symbol, unknown>)[other] = 'new';
    });
    expect(next).toBe(intern({ a: 1, [uniq]: { n: 2 }, [other]: 'new' }));
    expect(produce(base, (d) => void (d[reg] = 'r'))).toBe(base); // no-op write
    expect(produce(base, (d) => void (d[uniq].n = 1))).toBe(base); // netted out
    expect(produce(base, (d) => void delete (d as Record<symbol, unknown>)[other])).toBe(base); // absent
  });

  it('emits patches with symbol keys that apply and invert', () => {
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      d[uniq].n = 3;
      d[reg] = 'z';
      (d as Record<symbol, unknown>)[other] = 1;
    });
    expect(patches).toEqual([
      { kind: 'record.set', path: [uniq], key: 'n', value: 3 },
      { kind: 'record.set', path: [], key: reg, value: 'z' },
      { kind: 'record.set', path: [], key: other, value: 1 },
    ]);
    expect(applyPatches(base, patches)).toBe(next);
    expect(applyPatches(next, inverse)).toBe(base);
  });

  it('current() sees them', () => {
    produce(base, (d) => {
      d[reg] = 'q';
      expect(current(d)).toBe(intern({ a: 1, [uniq]: { n: 1 }, [reg]: 'q' }));
      expect(current(d)[reg]).toBe('q');
    });
  });

  it('the protocol symbols are reserved keys', () => {
    for (const sym of [equals, hashCode, interned, toDraft, DRAFT_STATE]) {
      expect(() => produce(base, (d) => void ((d as Record<symbol, unknown>)[sym] = 1))).toThrow(
        /reserved protocol key/,
      );
    }
  });

  it('arrays still take index keys only', () => {
    expect(() => produce(intern({ arr: [1] }), (d) => void ((d.arr as unknown as Record<symbol, unknown>)[uniq] = 1))).toThrow();
  });

  it('inspectors probing well-known symbols on a draft still get the prototype answer', () => {
    produce(base, (d) => {
      expect((d as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
      expect((d as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
      expect(String(d)).toBe('[object Object]');
    });
  });
});
