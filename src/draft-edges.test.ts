// ---------------------------------------------------------------------------
// Draft edge cases found by external review — each was a silent wrong answer
// or a misleading error:
//
// * a child draft over a PUSHED canonical element was parked where the array
//   never read it again, so edits through it were lost;
// * the array draft's method table inherited from Object.prototype, so
//   `toString`/`hasOwnProperty`/… were wrapped as mutating methods;
// * a draft assigned into itself finalized to "undefined" and the key vanished;
// * and a handful of smaller departures from plain-JS behaviour.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { produce, draft } from './produce.js';
import { current } from './current.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueList } from './value-list.js';

describe('editing an element that was pushed as a canonical value', () => {
  const c = intern({ x: 1 });

  it('a record', () => {
    const next = produce(intern([0] as unknown[]), (d) => {
      d.push(c);
      (d[1] as { y?: number }).y = 2;
    });
    expect(next).toBe(intern([0, { x: 1, y: 2 }]));
    expect(c).toEqual({ x: 1 }); // the canonical itself is untouched
  });

  it('an array, a collection, and several pushes', () => {
    const next = produce(intern([0] as unknown[]), (d) => {
      d.push(intern([1]), ValueMap.from([['k', 1]]), c);
      (d[1] as number[]).push(2);
      (d[2] as unknown as { set(k: string, v: number): void }).set('j', 2);
      (d[3] as { x: number }).x = 9;
    });
    expect(next).toBe(intern([0, [1, 2], ValueMap.from([['k', 1], ['j', 2]]), { x: 9 }]));
  });

  it('the same child draft comes back on every read, and survives a later push and pop', () => {
    const next = produce(intern([] as unknown[]), (d) => {
      d.push(c);
      const child = d[0] as { y?: number };
      expect(d[0]).toBe(child);
      d.push('tail');
      child.y = 1;
      d.pop();
      expect(d[0]).toBe(child);
    });
    expect(next).toBe(intern([{ x: 1, y: 1 }]));
  });

  it('edits that net out converge on the pushed canonical', () => {
    const next = produce(intern([] as unknown[]), (d) => {
      d.push(c);
      (d[0] as { x: number }).x = 5;
      (d[0] as { x: number }).x = 1;
    });
    expect(next[0]).toBe(c);
  });

  it('through a materialized array too', () => {
    const next = produce(intern([0] as unknown[]), (d) => {
      d.unshift('first'); // materializes
      d.push(c);
      (d[2] as { y?: number }).y = 2;
    });
    expect(next).toBe(intern(['first', 0, { x: 1, y: 2 }]));
  });
});

describe('an array draft answers Object.prototype members like an array', () => {
  const base = intern([1, 2, 3]);

  it('String, toString, valueOf, hasOwnProperty, constructor', () => {
    const next = produce(base, (d) => {
      expect(String(d)).toBe('1,2,3');
      expect(d.toString()).toBe('1,2,3');
      expect(`${d as unknown as string}`).toBe('1,2,3');
      expect(d.valueOf()).toBe(d);
      expect(Object.prototype.hasOwnProperty.call(d, '0')).toBe(true);
      expect((d as unknown as { hasOwnProperty(k: string): boolean }).hasOwnProperty('0')).toBe(true);
      expect((d as unknown as { hasOwnProperty(k: string): boolean }).hasOwnProperty('9')).toBe(false);
      expect(d.constructor).toBe(Array);
      expect(d.toLocaleString()).toBe('1,2,3');
      expect((d as unknown as { isPrototypeOf(o: object): boolean }).isPrototypeOf({})).toBe(false);
    });
    expect(next).toBe(base); // none of that is a mutation
  });

  it('reading one does not mark the draft modified: a replacement may still be returned', () => {
    expect(
      produce(base, (d) => {
        d.toString();
        void (d as unknown as { __proto__: unknown }).__proto__;
        return [9];
      }),
    ).toBe(intern([9]));
  });

  it('the real mutating methods are still captured', () => {
    expect(produce(base, (d) => void d.push(4))).toBe(intern([1, 2, 3, 4]));
    expect(produce(base, (d) => void d.splice(1, 1))).toBe(intern([1, 3]));
  });
});

describe('a draft cannot be assigned into itself', () => {
  const CYCLE = /assigned into itself/;

  it('directly, through a descendant, through a literal, into an array, into a map', () => {
    expect(() => produce(intern({ a: 1 } as Record<string, unknown>), (d) => void (d.self = d))).toThrow(CYCLE);
    expect(() => produce(intern({ a: { b: {} } } as { a: { b: Record<string, unknown> } }), (d) => void (d.a.b.up = d))).toThrow(CYCLE);
    expect(() => produce(intern({ a: 1 } as Record<string, unknown>), (d) => void (d.x = { wrapped: [d] }))).toThrow(CYCLE);
    expect(() => produce(intern([1] as unknown[]), (d) => void d.push(d))).toThrow(CYCLE);
    expect(() => produce(ValueMap.from<string, unknown>([['k', 1]]), (m) => void m.set('me', m))).toThrow(CYCLE);
    expect(() => produce(ValueList.of<unknown>(1), (l) => void l.push(l))).toThrow(CYCLE);
    expect(() => produce(intern({ a: 1 }), () => { const f = draft(intern({ q: 1 } as Record<string, unknown>)); f.me = f; return f as never; })).toThrow(CYCLE);
  });

  it('current() names the same mistake where it used to overflow the stack', () => {
    expect(() =>
      produce(intern({ a: 1 } as Record<string, unknown>), (d) => {
        d.self = d;
        current(d);
      }),
    ).toThrow(CYCLE);
  });

  it('a snapshot is how a value embeds its own earlier state', () => {
    const next = produce(intern({ a: 1 } as Record<string, unknown>), (d) => {
      d.prev = current(d);
      d.a = 2;
    });
    expect(next).toBe(intern({ a: 2, prev: { a: 1 } }));
  });

  it('aliasing one child draft in several places is not a cycle', () => {
    const next = produce(intern({ a: { x: 0 } } as Record<string, { x: number }>), (d) => {
      d.a!.x = 1;
      d.b = d.a!;
      d.c = d.a!;
      expect(current(d)).toBe(intern({ a: { x: 1 }, b: { x: 1 }, c: { x: 1 } }));
    });
    expect(next.b).toBe(next.a);
    expect(next.c).toBe(next.a);
  });
});

describe('plain-JS behaviour at the edges', () => {
  it('assigning undefined to an absent key is not a modification', () => {
    const base = intern({ a: 1 } as Record<string, unknown>);
    expect(produce(base, (d) => void (d.zzz = undefined))).toBe(base);
    // …so the recipe may still return a replacement,
    expect(produce(base, (d) => { d.zzz = undefined; return { b: 2 }; })).toBe(intern({ b: 2 }));
    // …while inside the recipe the key exists, as it would on a plain object.
    produce(base, (d) => {
      d.zzz = undefined;
      expect('zzz' in d).toBe(true);
      expect(Object.keys(d)).toEqual(['a', 'zzz']);
    });
    // Assigning undefined over a PRESENT key is a deletion, as before.
    expect(produce(base, (d) => void (d.a = undefined))).toBe(intern({}));
  });

  it("only canonical index spellings are indices: '01' is a property an array does not have", () => {
    produce(intern([1, 2]), (d) => {
      const loose = d as unknown as Record<string, unknown>;
      expect(loose['01']).toBeUndefined();
      expect('01' in d).toBe(false);
      expect('1' in d).toBe(true);
      expect(Object.getOwnPropertyDescriptor(d, '01')).toBeUndefined();
      expect(() => (loose['01'] = 9)).toThrow(/integer indices/);
      expect(() => (loose['1.0'] = 9)).toThrow(/integer indices/);
      expect(() => (loose['-1'] = 9)).toThrow(/integer indices/);
    });
    expect(produce(intern([1, 2]), (d) => void ((d as unknown as Record<string, number>)['1'] = 9))).toBe(intern([1, 9]));
  });

  it('delete draft.length is a TypeError about length, as on any array', () => {
    expect(() => produce(intern([1, 2]), (d) => void delete (d as unknown as { length?: number }).length)).toThrow(
      /cannot delete an array's length/,
    );
    expect(produce(intern([1, 2]), (d) => void delete d[0])).toBe(intern([undefined, 2]));
  });

  it('a draft that outlived its recipe gets the teaching error, not "revoked proxy"', () => {
    const FOREIGN = /a draft from a different produce\(\) call/;
    let leaked: unknown;
    produce(intern({ q: { z: 1 } }), (i) => void (leaked = i.q));
    expect(() => produce(intern({ a: 1 } as Record<string, unknown>), (o) => void (o.x = { w: leaked }))).toThrow(FOREIGN);
    expect(() => produce(intern({ a: 1 } as Record<string, unknown>), (o) => void (o.x = leaked))).toThrow(FOREIGN);
    expect(() => produce(intern([] as unknown[]), (o) => void o.push([leaked]))).toThrow(FOREIGN);
    expect(() => produce(intern({ a: 1 }) as unknown, () => ({ w: leaked }))).toThrow(FOREIGN);
  });

  it('util.inspect shows what a draft holds, not its internals', () => {
    produce(intern({ a: 1, xs: [1, { k: 2 }] as unknown[] } as Record<string, unknown>), (d) => {
      d.b = 2;
      const xs = d.xs as unknown[];
      xs.push(3);
      (xs[1] as { k: number }).k = 9;
      expect(inspect(d, { depth: 4 })).toBe('{ a: 1, xs: [ 1, { k: 9 }, 3 ], b: 2 }');
      expect(inspect(xs)).toBe('[ 1, { k: 9 }, 3 ]');
      // The hook lives on the proxy target and never shows through the draft.
      expect(Reflect.ownKeys(d)).toEqual(['a', 'xs', 'b']);
      expect(Reflect.ownKeys(xs)).toEqual(['0', '1', '2', 'length']);
    });
  });
});

// Without a trap, a proxy operation falls through to the proxy's TARGET, which
// for a draft is valsem's internal state, not the data. On an array draft
// `Object.defineProperty(d.arr, '0', …)` overwrote the state slot: the write
// was lost, and the next read failed inside valsem. `Object.freeze(draft)`, on
// either kind, made the target non-extensible and tripped the engine's proxy
// invariants ("'ownKeys' on proxy: trap result did not include 'kind'").
describe('the operations a draft does not support say so', () => {
  const base = intern({ o: { a: 1 }, arr: [1, 2] });
  type Loose = Record<string, (...args: unknown[]) => unknown>;

  it('defineProperty, on a record draft and an array draft alike', () => {
    for (const pick of [(d: typeof base) => d.o, (d: typeof base) => d.arr] as ((d: unknown) => object)[]) {
      expect(() => produce(base, (d) => void Object.defineProperty(pick(d), '0', { value: 9, writable: true, enumerable: true, configurable: true }))).toThrow(
        'valsem: defineProperty is not supported on drafts',
      );
      expect(() => produce(base, (d) => void Object.defineProperty(pick(d), 'x', { get: () => 1 }))).toThrow(/defineProperty is not supported/);
      expect(() => produce(base, (d) => void (pick(d) as unknown as Loose).__defineSetter__!('0', () => {}))).toThrow(/defineProperty is not supported/);
    }
  });

  it('preventExtensions, seal and freeze', () => {
    for (const pick of [(d: typeof base) => d.o, (d: typeof base) => d.arr] as ((d: unknown) => object)[]) {
      for (const op of [Object.preventExtensions, Object.seal, Object.freeze]) {
        expect(() => produce(base, (d) => void op(pick(d)))).toThrow('valsem: preventExtensions, seal and freeze are not supported on drafts');
      }
    }
  });

  it('and leave the draft usable: nothing reached the internal state', () => {
    const next = produce(base, (d) => {
      expect(() => Object.defineProperty(d.arr, '0', { value: 9 })).toThrow(TypeError);
      expect(() => Object.freeze(d.arr)).toThrow(TypeError);
      expect(() => Object.freeze(d.o)).toThrow(TypeError);
      expect(d.arr[0]).toBe(1);
      expect(Object.keys(d.o)).toEqual(['a']);
      d.arr.push(3);
      d.o.a = 2;
    });
    expect(next).toBe(intern({ o: { a: 2 }, arr: [1, 2, 3] }));
  });
});

describe('fill checks its value where it is passed', () => {
  it('a draft of another recipe fails at the fill call, as at a push or an index write', () => {
    produce(intern({ x: { y: 1 } }), (outer) => {
      produce(intern({ arr: [0, 0] }), (d) => {
        expect(() => d.arr.fill(outer.x as never)).toThrow('valsem: cannot assign a draft from a different produce() call.');
        expect(() => d.arr.push(outer.x as never)).toThrow('valsem: cannot assign a draft from a different produce() call.');
        expect(() => void (d.arr[0] = outer.x as never)).toThrow('valsem: cannot assign a draft from a different produce() call.');
      });
    });
  });

  it('the caught call leaves the draft untouched, and an honest fill still works', () => {
    const base = intern({ arr: [0, 0] });
    produce(intern({ x: { y: 1 } }), (outer) => {
      const same = produce(base, (d) => {
        try {
          d.arr.fill(outer.x as never);
        } catch {
          /* the recipe carries on */
        }
      });
      expect(same).toBe(base);
    });
    expect(produce(base, (d) => void d.arr.fill(7)).arr).toEqual([7, 7]);
    // sort and copyWithin take no value: a comparator is a function, and is not data.
    expect(produce(intern({ arr: [2, 1] }), (d) => void d.arr.sort((a, b) => a - b)).arr).toEqual([1, 2]);
  });
});
