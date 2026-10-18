// ---------------------------------------------------------------------------
// Two copies of valsem in one process — the npm outcome when a transitive
// dependency pins a different range, and a packaging error: a library that
// uses valsem declares it a peer dependency, so that there is one copy.
//
// The position (D4): the copies are separate libraries. Each has a seed, a
// pool and protocol symbols of its own, shares nothing through globalThis,
// and a value of one — a collection, a value class, a draftable — is not a
// value to the other, which says so when it meets one: intern, deepHash and
// the collections refuse it with the reason, and deepEqual answers by
// reference, with the development warning. Plain data has no copy: it
// compares, hashes and interns in either.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Loaded with copy A (the static import runs first, into the graph A then joins).
import { COLLECTIONS } from './roster.test-helpers.js';

const A = await import('./index.js');
vi.resetModules();
const B = await import('./index.js');

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeEach(() => warn.mockClear());

const anotherCopy = /is a value of another copy of valsem.*peer dependency/s;

describe('duplicate install — two module graphs', () => {
  it('really are two copies, each with a seed and symbols of its own, and nothing on globalThis', () => {
    expect(A.ValueList).not.toBe(B.ValueList);
    expect(A.deepEqual).not.toBe(B.deepEqual);
    expect(String(A.getHashSeed())).not.toBe(String(B.getHashSeed()));
    expect(A.deepHash({ x: [1, 's'] })).not.toBe(B.deepHash({ x: [1, 's'] }));
    expect(A.equals).not.toBe(B.equals);
    expect(A.hash).not.toBe(B.hash);
    expect(A.interned).not.toBe(B.interned);
    expect(A.equals.description).toBe(B.equals.description);
    expect(Object.getOwnPropertySymbols(globalThis).filter((s) => s.description?.startsWith('valsem.'))).toEqual([]);
  });

  it('each copy numbers unique symbols itself, consistently', () => {
    const s = Symbol('one');
    expect(A.deepHash(s)).toBe(A.deepHash(s));
    expect(B.deepHash(s)).toBe(B.deepHash(s));
    expect(A.deepHash({ k: [s], [s]: 1 })).toBe(A.deepHash({ [s]: 1, k: [s] }));
  });

  it.each(COLLECTIONS.map((c) => [c.name, c] as const))("%s from the other copy is refused, with the reason", (name, c) => {
    const local = c.of('a');
    const Foreign = (B as unknown as Record<string, { from(items: unknown[]): object }>)[name]!;
    const foreign = Foreign.from(c.keyed ? [['a', 'a']] : ['a']);
    expect(local).toBeInstanceOf((A as unknown as Record<string, unknown>)[name]); // the roster is copy A's
    expect(foreign).not.toBeInstanceOf(c.type);
    // By reference to deepEqual, from both sides and in both copies…
    for (const copy of [A, B]) {
      expect(copy.deepEqual(local, foreign)).toBe(false);
      expect(copy.deepEqual(foreign, local)).toBe(false);
    }
    // …and not a value where a value is required.
    expect(() => A.intern(foreign)).toThrow(anotherCopy);
    expect(() => A.deepHash(foreign)).toThrow(anotherCopy);
    expect(() => new A.HashMap().set(foreign, 1)).toThrow(anotherCopy);
    expect(() => c.of(foreign)).toThrow(anotherCopy); // members intern on entry
    expect(A.isCanonical(foreign)).toBe(false);
  });

  it('a user value type written against one copy is not a value to the other, and the other says so', () => {
    class Money {
      constructor(readonly amount: number) {}
      [A.equals](o: unknown): boolean {
        return o instanceof Money && o.amount === this.amount;
      }
      [A.hash](hasher: Parameters<typeof A.deepHash>[1]): number {
        return A.deepHash(this.amount, hasher);
      }
    }
    // Its own copy: a value.
    expect(A.deepEqual(new Money(1), new Money(1))).toBe(true);
    expect(A.intern(new Money(1))).toBe(A.intern(new Money(1)));
    // The other copy: refused where a value is required, with the fix.
    expect(() => B.intern(new Money(1))).toThrow(anotherCopy);
    expect(() => B.deepHash(new Money(1))).toThrow(/Money is a value of another copy of valsem/);
    expect(() => new B.HashMap().set(new Money(1), 'x')).toThrow(anotherCopy);
    expect(() => B.ValueList.of(new Money(1))).toThrow(anotherCopy);
    expect(() => B.intern({ price: new Money(1) })).toThrow(anotherCopy);
    // deepEqual stays total: by reference, and the development warning says why, once per type.
    expect(B.deepEqual(new Money(1), new Money(1))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/Money instances.*REFERENCE.*another copy of valsem.*peer dependency/s);
    expect(B.deepEqual(new Money(2), new Money(2))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a draftable written against one copy is opaque to the other', () => {
    // `toDraft` is a symbol of its copy too: B's produce would not draft an A
    // type — and does not get to, since the type is refused at the door.
    class Box {
      constructor(readonly v: number) {}
      [A.equals](o: unknown): boolean {
        return o instanceof Box && o.v === this.v;
      }
      [A.hash](hasher: Parameters<typeof A.deepHash>[1]): number {
        return A.deepHash(this.v, hasher);
      }
    }
    expect(() => B.produce({ box: new Box(1) }, () => {})).toThrow(anotherCopy);
  });

  it('plain data has no copy: equal across copies, re-interned locally', () => {
    const oa = A.intern({ x: [1, { y: 2 }] });
    const ob = B.intern({ x: [1, { y: 2 }] });
    expect(oa).not.toBe(ob);
    expect(A.deepEqual(oa, ob)).toBe(true);
    expect(B.deepEqual(oa, ob)).toBe(true);
    expect(A.deepHash(oa)).toBe(A.deepHash(ob));
    expect(A.intern(ob)).toBe(oa);
    expect(A.produce(oa, () => {})).toBe(oa);
    expect(A.produce(ob, () => {})).toBe(oa); // produce(base) === intern(base)
  });
});
