// ---------------------------------------------------------------------------
// Two copies of valsem in one process — the ordinary npm outcome when a
// transitive dependency pins a different minor.
//
// The position: a collection from another copy is a DIFFERENT TYPE. Nothing
// guarantees two versions agree on hashing, iteration order, or the meaning
// of [equals], so their instances compare unequal — the same answer as for
// any two distinct canonical instances — and pass through `intern` opaque.
// Plain data has no such type boundary and still compares structurally; the
// hash seed is shared through globalThis, so hashes agree across copies.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from 'vitest';

const A = await import('./index.js');
vi.resetModules();
const B = await import('./index.js');

describe('duplicate install — two module graphs', () => {
  it('really are two copies sharing one seed', () => {
    expect(A.ValueList).not.toBe(B.ValueList);
    expect(A.deepEqual).not.toBe(B.deepEqual);
    expect(String(A.getHashSeed())).toBe(String(B.getHashSeed()));
    expect(A.deepHash('s')).toBe(B.deepHash('s'));
    expect(A.deepHash({ x: [1] })).toBe(B.deepHash({ x: [1] }));
  });

  it("the other copy's collections are a different type: unequal, from both sides, in O(1)", () => {
    const la = A.ValueList.of(1, 2);
    const lb = B.ValueList.of(1, 2);
    expect(lb).not.toBeInstanceOf(A.ValueList);
    expect(A.deepEqual(la, lb)).toBe(false);
    expect(B.deepEqual(la, lb)).toBe(false);
    expect(A.deepEqual(lb, la)).toBe(false);

    expect(A.deepEqual(A.ValueMap.from([['a', 1]]), B.ValueMap.from([['a', 1]]))).toBe(false);
    expect(A.deepEqual(A.ValueSet.from([1]), B.ValueSet.from([1]))).toBe(false);
    expect(A.deepEqual(A.InternedString.for('q'), B.InternedString.for('q'))).toBe(false);
    // …exactly as [equals] itself answers.
    expect(la[A.equals](lb)).toBe(false);
  });

  it("intern passes the other copy's collections through untouched", () => {
    const lb = B.ValueList.of(1);
    expect(A.intern(lb)).toBe(lb);
    expect(A.intern(B.ValueSet.from([1]))).toBeInstanceOf(B.ValueSet);
    // Stored as an opaque member — a different value from the local twin.
    const holdingForeign = A.ValueList.of(lb);
    const holdingLocal = A.ValueList.of(A.ValueList.of(1));
    expect(holdingForeign).not.toBe(holdingLocal);
    expect(holdingForeign.get(0)).toBe(lb);
    expect(A.deepEqual(holdingForeign, holdingLocal)).toBe(false);
  });

  it('a user value type written against one copy is recognised by the other (shared protocol)', () => {
    // The reason the protocol symbols are Symbol.for: a Money class from a
    // library on copy A must not silently fall to reference semantics when
    // the app's copy B compares it.
    expect(A.equals).toBe(B.equals);
    expect(A.hashCode).toBe(B.hashCode);
    expect(A.interned).toBe(B.interned);
    class Money {
      constructor(readonly amount: number) {}
      [A.equals](o: unknown): boolean {
        return o instanceof Money && o.amount === this.amount;
      }
      get [A.hashCode](): number {
        return A.deepHash(this.amount);
      }
    }
    expect(B.deepEqual(new Money(1), new Money(1))).toBe(true);
    expect(B.deepEqual(new Money(1), new Money(2))).toBe(false);
    expect(B.deepHash(new Money(1))).toBe(A.deepHash(new Money(1)));
  });

  it('plain interned data has no type boundary: equal across copies, re-interned locally', () => {
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
