// ---------------------------------------------------------------------------
// Adversarial input — the paths hostile or merely unlucky data takes.
//
// Every case here was a shipped defect or its immediate neighbour: a guard
// that leaked, a hardened writer one call site skipped, a membership test
// that walked the prototype chain, a configuration API that accepted a
// corrupting call. The tests are written at the strength the property
// needs (loop the rejection; include the alias; check every write path).
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { configureHasher } from './hasher.js';
import { produce, produceWithPatches, applyPatches } from './produce.js';
import { ValueMap } from './value-map.js';
import { HashMap } from './hash-map.js';

/** `{name:'a', n:1}` merged with a payload — built by JSON.parse, because
 * `Object.assign` uses [[Set]] and would swallow a `__proto__` key. */
const merged = (payload: string): Record<string, unknown> =>
  JSON.parse('{"name":"a","n":1,' + payload.slice(1)) as Record<string, unknown>;

/** Payloads that JSON.parse will happily hand to a merge loop. */
const HOSTILE = [
  '{"toString":"x"}',
  '{"constructor":"x"}',
  '{"valueOf":1}',
  '{"hasOwnProperty":1}',
  '{"__proto__":{"isAdmin":true}}',
  '{"__proto__":null}',
  '{"__defineGetter__":"g","propertyIsEnumerable":0}',
] as const;

describe('prototype-chain keys reach records only as OWN keys', () => {
  const base = intern({ name: 'a', n: 1 });

  it.each(HOSTILE)('merge loop through a record draft: %s', (payload) => {
    const untrusted = JSON.parse(payload) as Record<string, unknown>;
    const expected = intern(merged(payload));
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      for (const [k, v] of Object.entries(untrusted)) (d as Record<string, unknown>)[k] = v;
    });
    expect(next).toBe(expected);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.keys(next).sort()).toEqual([...Object.keys(untrusted), 'n', 'name'].sort());
    expect(deepEqual(next, expected)).toBe(true);
    // Patches describe own keys, and round-trip both ways.
    for (const p of patches) expect(p.kind).toBe('record.set');
    for (const p of inverse) expect(p.kind).toBe('record.delete');
    expect(applyPatches(base, patches)).toBe(expected);
    expect(applyPatches(next, inverse)).toBe(base);
  });

  it.each(HOSTILE)('graft of decoded data: %s', (payload) => {
    const untrusted = JSON.parse(payload) as Record<string, unknown>;
    const next = produce(base, (d) => void ((d as Record<string, unknown>).x = untrusted));
    expect(next).toBe(intern({ name: 'a', n: 1, x: untrusted }));
    const x = (next as { x: object }).x;
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    expect(Object.keys(x).sort()).toEqual(Object.keys(untrusted).sort());
  });

  it.each(HOSTILE)('applyPatches record.set: %s', (payload) => {
    const untrusted = JSON.parse(payload) as Record<string, unknown>;
    const patches = Object.entries(untrusted).map(([key, value]) => ({
      kind: 'record.set' as const,
      path: [],
      key,
      value,
    }));
    expect(applyPatches(base, patches)).toBe(intern(merged(payload)));
  });

  it.each(HOSTILE)('DraftMap.set: %s', (payload) => {
    const untrusted = JSON.parse(payload) as Record<string, unknown>;
    const mapBase = ValueMap.from<string, unknown>([['name', 'a']]);
    const next = produce(mapBase, (d) => {
      for (const [k, v] of Object.entries(untrusted)) d.set(k, v);
    });
    expect(next.size).toBe(1 + Object.keys(untrusted).length);
    for (const [k, v] of Object.entries(untrusted)) expect(next.get(k)).toBe(intern(v));
  });

  it('deleting an inherited name is a no-op, not a phantom deletion', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const [next, patches] = produceWithPatches(base, (d) => {
        delete (d as Record<string, unknown>)[key];
      });
      expect(next).toBe(base);
      expect(patches).toEqual([]);
    }
  });

  it('assigning the inherited member itself is a real write (and then a real rejection)', () => {
    // `d.toString = Object.prototype.toString` must not be swallowed as
    // "already equal" — it is a write of a function, and functions are not
    // values: the hasher rejects it with its own error, not a phantom no-op.
    expect(() =>
      produce(base, (d) => {
        (d as Record<string, unknown>)['toString'] = Object.prototype.toString;
      }),
    ).toThrow(/function is not supported/);
  });

  it('reading an inherited name through a draft still resolves the prototype', () => {
    produce(base, (d) => {
      expect(typeof (d as { toString: unknown }).toString).toBe('function');
      expect('toString' in (d as object)).toBe(true);
      expect(Object.hasOwn(d as object, 'toString')).toBe(false);
    });
  });

  it('__proto__ own keys survive intern and HashMap keying', () => {
    const rec = JSON.parse('{"__proto__":{"isAdmin":true},"id":1}') as Record<string, unknown>;
    const c = intern(rec);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.hasOwn(c, '__proto__')).toBe(true);
    const m = new HashMap<Record<string, unknown>, string>();
    m.set(rec, 'v');
    expect(m.get(JSON.parse('{"id":1,"__proto__":{"isAdmin":true}}'))).toBe('v');
    expect(m.get({ id: 1 })).toBeUndefined();
  });
});

describe('prototype pollution cannot split equality from hashing', () => {
  it('records with Object.prototype and null prototype agree under pollution', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto['polluted'] = 'yes';
    try {
      const a = { x: 1 };
      const b = Object.assign(Object.create(null), { x: 1 }) as Record<string, unknown>;
      expect(deepEqual(a, b)).toBe(true);
      expect(deepHash(a)).toBe(deepHash(b));
      expect(intern(a)).toBe(intern(b));
      expect(intern(a)).toBe(intern({ x: 1 }));
      expect(Object.hasOwn(intern(a), 'polluted')).toBe(false);
      expect(ValueMap.fromObject({ x: 1 }).size).toBe(1);
      expect(produce(intern({ x: 1 }), () => {})).toBe(intern({ x: 1 }));
    } finally {
      delete proto['polluted'];
    }
  });
});

describe('configureHasher ordering guard', () => {
  it('rejects a swap once anything has been hashed, and leaves the pool intact', () => {
    const a = intern({ hkey: 'shared-structure', n: 1 });
    expect(() => configureHasher({ string: () => 1, number: () => 2 })).toThrow(
      /before any value is hashed/,
    );
    // The rejected call changed nothing: equal values still converge.
    const b = intern({ hkey: 'shared-structure', n: 1 });
    expect(b).toBe(a);
    expect(deepEqual(a, b)).toBe(true);
    expect(deepHash('probe')).toBe(deepHash('probe'));
  });
});
