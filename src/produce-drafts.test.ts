// ---------------------------------------------------------------------------
// The draft API surface itself — DraftMap / DraftSet / DraftList methods and
// the proxy traps — each exercised directly, inside and after a recipe.
// (The produce suites test outcomes; this one tests the instruments.)
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, } from './produce.js';
import { DraftMap } from './draft-map.js';
import { DraftSet } from './draft-set.js';
import { DraftList } from './draft-list.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

describe('DraftMap — iteration, size, clear', () => {
  const base = ValueMap.from<string, number>([
    ['a', 1],
    ['b', 2],
  ]);

  it('entries/keys/values/[Symbol.iterator]/forEach reflect edits and deletions', () => {
    produce(base, (d) => {
      d.set('c', 3);
      d.delete('a');
      d.set('b', 20);
      const entries = [...d.entries()].sort();
      expect(entries).toEqual([
        ['b', 20],
        ['c', 3],
      ]);
      expect([...d.keys()].sort()).toEqual(['b', 'c']);
      expect([...d.values()].sort((x, y) => x - y)).toEqual([3, 20]);
      expect([...d].sort()).toEqual(entries);
      const seen: [string, number, unknown][] = [];
      d.forEach(function (this: unknown, v, k, m) {
        seen.push([k, v, this]);
        expect(m).toBe(d);
      }, 'thisArg');
      expect(seen.sort()).toEqual([
        ['b', 20, 'thisArg'],
        ['c', 3, 'thisArg'],
      ]);
      expect(d.size).toBe(2);
      expect(d.has('a')).toBe(false);
      expect(d.has('c')).toBe(true);
    });
  });

  it('a child-drafted entry iterates as its draft, not the base value', () => {
    const nested = ValueMap.from<string, { n: number }>([['k', { n: 1 }]]);
    const next = produce(nested, (d) => {
      d.get('k')!.n = 2;
      for (const [, v] of d) expect(v.n).toBe(2);
      expect([...d.values()][0]!.n).toBe(2);
    });
    expect(next.get('k')).toBe(intern({ n: 2 }));
  });

  it('clear() empties, size drops to zero, and later sets re-populate', () => {
    const [next, patches] = produceWithPatches(base, (d) => {
      d.clear();
      expect(d.size).toBe(0);
      expect([...d]).toEqual([]);
      expect(d.has('a')).toBe(false);
      expect(d.get('a')).toBeUndefined();
      d.set('z', 9);
      expect(d.size).toBe(1);
      expect([...d.keys()]).toEqual(['z']);
      d.clear(); // clear again — a no-op on an already-cleared-then-set map? No: it has 'z'.
      expect(d.size).toBe(0);
      d.set('z', 9);
    });
    expect(next).toBe(ValueMap.from([['z', 9]]));
    expect(patches.map((p) => p.kind).sort()).toEqual(['map.delete', 'map.delete', 'map.set']);
  });

  it('size is kept as edits go, not counted: every kind of edit, in every order', () => {
    // set of a new key, of a present key, of a present key to the same value (a no-op), delete of a
    // present and of an absent key, clear, and sets after a clear — against a native Map doing the same.
    const big = ValueMap.from(Array.from({ length: 50 }, (_, i) => ['k' + i, i] as const));
    produce(big, (d) => {
      const model = new Map<string, number>(big);
      let step = 0;
      const check = (): void => expect(d.size, `step ${step++}`).toBe(model.size);
      d.set('new', 1); model.set('new', 1); check();
      d.set('k3', 99); model.set('k3', 99); check();
      d.set('k3', 99); check(); // the same value: no edit, no change
      expect(d.delete('k4')).toBe(true); model.delete('k4'); check();
      expect(d.delete('k4')).toBe(false); check();
      expect(d.delete('nope')).toBe(false); check();
      d.set('k4', 4); model.set('k4', 4); check(); // deleted, then set again
      d.clear(); model.clear(); check();
      d.set('a', 1); model.set('a', 1); check();
      d.set('k0', 0); model.set('k0', 0); check(); // a base key, after the clear
      expect(d.delete('a')).toBe(true); model.delete('a'); check();
      d.clear(); model.clear(); check();
    });
  });

  it('reading size in a loop of sets costs nothing extra (it was quadratic)', () => {
    const base = ValueMap.from(Array.from({ length: 10_000 }, (_, i) => ['k' + i, i] as const));
    const time = (read: boolean): number => {
      const t0 = performance.now();
      produce(base, (d) => {
        for (let i = 0; i < 3000; i++) {
          d.set('new' + i, i);
          if (read) expect(d.size).toBe(10_000 + i + 1);
        }
      });
      return performance.now() - t0;
    };
    time(false); // warm
    const without = time(false);
    const withReads = time(true);
    expect(withReads).toBeLessThan(without * 5 + 50); // was 40x; the reads themselves cost something
  });

  it('clear() on an empty map is a no-op that leaves the base untouched', () => {
    const empty = ValueMap.empty<string, number>();
    expect(produce(empty, (d) => void d.clear())).toBe(empty);
  });

  it('cannot be constructed directly', () => {
    expect(() => new (DraftMap as unknown as new (...a: unknown[]) => unknown)(Symbol(), {})).toThrow(
      /created by produce/,
    );
  });
});

describe('DraftSet — size, clear, iteration', () => {
  const base = ValueSet.from([1, 2, 3]);

  it('values/keys/[Symbol.iterator]/forEach/size track add and delete', () => {
    produce(base, (d) => {
      d.delete(2);
      d.add(4);
      d.add(4); // duplicate add is a no-op
      expect(d.size).toBe(3);
      expect([...d.values()].sort()).toEqual([1, 3, 4]);
      expect([...d.keys()].sort()).toEqual([1, 3, 4]);
      expect([...d].sort()).toEqual([1, 3, 4]);
      const seen: [number, number, unknown][] = [];
      d.forEach(function (this: unknown, v, v2, s) {
        seen.push([v, v2, this]);
        expect(s).toBe(d);
      }, 'thisArg');
      expect(seen.sort()).toEqual([
        [1, 1, 'thisArg'],
        [3, 3, 'thisArg'],
        [4, 4, 'thisArg'],
      ]);
    });
  });

  it('re-adding a deleted base member restores it with no net change', () => {
    const [next, patches] = produceWithPatches(base, (d) => {
      d.delete(2);
      expect(d.has(2)).toBe(false);
      d.add(2);
      expect(d.has(2)).toBe(true);
      expect(d.size).toBe(3);
    });
    expect(next).toBe(base);
    expect(patches).toEqual([]);
  });

  it('clear() then add: size, membership, and the result', () => {
    const [next, patches] = produceWithPatches(base, (d) => {
      d.clear();
      expect(d.size).toBe(0);
      expect(d.has(1)).toBe(false);
      expect([...d]).toEqual([]);
      expect(d.delete(1)).toBe(false);
      d.add(7);
      d.add(1); // a base member added back after clear
      expect(d.size).toBe(2);
    });
    expect(next).toBe(ValueSet.from([7, 1]));
    expect(patches.map((p) => p.kind).sort()).toEqual(['set.add', 'set.delete', 'set.delete']);
  });

  it('members are handed out as canonical values, never as drafts', () => {
    const s = ValueSet.from([{ n: 1 }]);
    produce(s, (d) => {
      for (const m of d) {
        expect(Object.isFrozen(m)).toBe(true);
        expect(m).toBe(intern({ n: 1 }));
      }
    });
  });

  it('cannot be constructed directly', () => {
    expect(() => new (DraftSet as unknown as new (...a: unknown[]) => unknown)(Symbol(), {})).toThrow(
      /created by produce/,
    );
  });
});

describe('DraftList — get, toArray, length', () => {
  const base = ValueList.of(1, 2, 3);

  it('get() bounds: negative, fractional, past-the-end, and after growth', () => {
    produce(base, (d) => {
      expect(d.get(0)).toBe(1);
      expect(d.get(2)).toBe(3);
      for (const i of [3, -1, 1.5, NaN]) expect(() => d.get(i)).toThrow(RangeError);
      d.push(4);
      expect(d.get(3)).toBe(4);
      expect(d.length).toBe(4);
    });
  });

  it('toArray() and iteration reflect virtual edits, the tail, and materialized state', () => {
    produce(base, (d) => {
      d.set(0, 99);
      d.push(4, 5);
      expect(d.toArray()).toEqual([99, 2, 3, 4, 5]);
      expect([...d]).toEqual([99, 2, 3, 4, 5]);
      d.splice(1, 1); // materializes
      expect(d.toArray()).toEqual([99, 3, 4, 5]);
      expect(d.length).toBe(4);
      expect(d.get(1)).toBe(3);
    });
  });

  it('get() drafts a base-positioned object, once, and the draft is what iterates', () => {
    const list = ValueList.from([{ n: 1 }, { n: 2 }]);
    const next = produce(list, (d) => {
      const first = d.get(0)!;
      expect(d.get(0)).toBe(first); // memoized child draft
      first.n = 42;
      expect(d.toArray()[0]!.n).toBe(42);
      expect([...d][0]!.n).toBe(42);
    });
    expect(next).toBe(ValueList.from([{ n: 42 }, { n: 2 }]));
    expect(next.get(1)).toBe(list.get(1)); // untouched sibling shared
  });

  it('pop() past the tail pulls from the base; pop() on empty is undefined', () => {
    produce(base, (d) => {
      expect(d.pop()).toBe(3);
      expect(d.pop()).toBe(2);
      expect(d.pop()).toBe(1);
      expect(d.pop()).toBeUndefined();
      expect(d.length).toBe(0);
      expect(d.toArray()).toEqual([]);
    });
  });

  it('cannot be constructed directly', () => {
    expect(() => new (DraftList as unknown as new (...a: unknown[]) => unknown)(Symbol(), {})).toThrow(
      /created by produce/,
    );
  });
});

describe('record and array proxy traps', () => {
  it('defineProperty and setPrototypeOf are rejected on a record draft', () => {
    produce(intern({ a: 1 }), (d) => {
      expect(() => Object.defineProperty(d, 'x', { value: 1 })).toThrow(/defineProperty is not supported/);
      expect(() => Object.setPrototypeOf(d, null)).toThrow(/cannot set the prototype/);
      expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    });
  });

  it('setPrototypeOf is rejected on an array draft; the prototype reads as Array.prototype', () => {
    produce(intern([1, 2]), (d) => {
      expect(() => Object.setPrototypeOf(d, null)).toThrow(/cannot set the prototype/);
      expect(Object.getPrototypeOf(d)).toBe(Array.prototype);
      expect(Array.isArray(d)).toBe(true);
    });
  });

  it('delete arr[i] is set-to-undefined (arrays are positional)', () => {
    const next = produce(intern([1, 2, 3]), (d) => {
      delete d[1];
    });
    expect(next).toBe(intern([1, undefined, 3]));
    expect(next.length).toBe(3);
  });

  it('symbol-keyed writes land on records and are rejected on arrays', () => {
    const sym = Symbol('s');
    expect(
      produce(intern({ a: 1 }), (d) => {
        (d as Record<symbol, unknown>)[sym] = 1;
      }),
    ).toBe(intern({ a: 1, [sym]: 1 }));
    expect(() =>
      produce(intern([1]), (d) => {
        (d as unknown as Record<symbol, unknown>)[sym] = 1;
      }),
    ).toThrow(/integer indices/);
  });

  it('escaped drafts of every kind throw on use', () => {
    let rec: Record<string, unknown> | undefined;
    let arr: unknown[] | undefined;
    let map: DraftMap<string, number> | undefined;
    let set: DraftSet<number> | undefined;
    let list: DraftList<number> | undefined;
    produce(
      intern({ r: { a: 1 }, x: [1], m: ValueMap.from([['k', 1]]), s: ValueSet.from([1]), l: ValueList.of(1) }),
      (d) => {
        rec = d.r;
        arr = d.x;
        map = d.m;
        set = d.s;
        list = d.l;
      },
    );
    // Proxies are revoked by the engine (native message); collection drafts
    // carry the teaching message. Both are TypeErrors/Errors on any use.
    expect(() => rec!.a).toThrow(/revoked/);
    expect(() => arr!.length).toThrow(/revoked/);
    expect(() => map!.get('k')).toThrow(/escaped its produce\(\) call/);
    expect(() => set!.has(1)).toThrow(/escaped its produce\(\) call/);
    expect(() => list!.get(0)).toThrow(/escaped its produce\(\) call/);
  });
});

describe('an array draft is an array to reflection too', () => {
  it('describes its indices and its length as own, writable properties', () => {
    produce(intern([10, 20]), (d) => {
      expect(Object.getOwnPropertyDescriptor(d, 0)).toEqual({ value: 10, writable: true, configurable: true, enumerable: true });
      expect(Object.getOwnPropertyDescriptor(d, 'length')).toEqual({ value: 2, writable: true, configurable: false, enumerable: false });
      expect(Object.getOwnPropertyDescriptor(d, 5)).toBeUndefined();
      d[1] = 21;
      d.push(30);
      expect(Object.getOwnPropertyDescriptor(d, 1)!.value).toBe(21); // from the copy, once there is one
      expect(Object.getOwnPropertyDescriptor(d, 2)!.value).toBe(30);
      expect(Object.keys(d)).toEqual(['0', '1', '2']);
    });
  });

  it('2^32 - 1 is not an index, as on any array: it reads as a property that is not there', () => {
    produce(intern([1, 2]), (d) => {
      const notAnIndex = d as unknown as Record<string, unknown>;
      expect(notAnIndex['4294967295']).toBeUndefined();
      expect('4294967295' in d).toBe(false);
      expect(notAnIndex['4294967294']).toBeUndefined(); // an index, merely out of range
      expect(d.length).toBe(2);
    });
  });
});

describe('record patches for undefined and for what was never there', () => {
  it('assigning undefined to a key is its deletion, in the patches as in the value', () => {
    const base = intern({ a: 1, b: 2 }) as { a?: number; b: number };
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      d.a = undefined;
    });
    expect(next).toBe(intern({ b: 2 }));
    expect(patches).toEqual([{ kind: 'record.delete', path: [], key: 'a' }]);
    expect(inverse).toEqual([{ kind: 'record.set', path: [], key: 'a', value: 1 }]);
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('deleting, or assigning undefined to, a key that was never there records nothing', () => {
    const base = intern({ a: 1 }) as Record<string, number | undefined>;
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      delete d['never'];
      d['nor'] = undefined;
      d['a'] = 2;
    });
    expect(next).toBe(intern({ a: 2 }));
    expect(patches).toEqual([{ kind: 'record.set', path: [], key: 'a', value: 2 }]);
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('a raw record adopted into a recipe drops its undefined-valued keys, like any record', () => {
    const next = produce(intern({ held: null as unknown }), (d) => {
      d.held = { kept: 1, dropped: undefined, deep: [{ also: undefined, n: 2 }] };
    });
    expect(next).toBe(intern({ held: { kept: 1, deep: [{ n: 2 }] } }));
    expect(Object.hasOwn(next.held as object, 'dropped')).toBe(false);
  });
});

describe('an array recipe that rewrites its end with what was there', () => {
  it('nets out to the base with no patches, the first time and from the remembered transition', () => {
    const base = intern([{ id: 1 }, { id: 2 }, { id: 3 }]);
    for (let run = 0; run < 3; run++) {
      const [next, patches, inverse] = produceWithPatches(base, (d) => {
        const last = d.pop()!;
        d.push({ id: last.id }); // an equal element, built anew
      });
      expect(next).toBe(base);
      expect(patches).toEqual([]);
      expect(inverse).toEqual([]);
    }
  });
});
