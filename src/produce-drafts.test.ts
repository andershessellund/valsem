// ---------------------------------------------------------------------------
// The draft API surface itself — DraftMap / DraftSet / DraftList methods and
// the proxy traps — each exercised directly, inside and after a recipe.
// (The produce suites test outcomes; this one tests the instruments.)
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, DraftMap, DraftSet, DraftList } from './produce.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';

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
      expect(d.get(3)).toBeUndefined();
      expect(d.get(-1)).toBeUndefined();
      expect(d.get(1.5)).toBeUndefined();
      expect(d.get(NaN)).toBeUndefined();
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

  it('symbol-keyed writes are rejected on records and arrays', () => {
    const sym = Symbol('s');
    expect(() =>
      produce(intern({ a: 1 }), (d) => {
        (d as Record<symbol, unknown>)[sym] = 1;
      }),
    ).toThrow(/string keys only/);
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
