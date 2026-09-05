import { describe, expect, it } from 'vitest';
import { ValueList } from './value-list.js';
import { equals, hashCode, interned } from './deep-equal.js';

describe('ValueList', () => {
  it('empty arrays are identical', () => {
    expect(ValueList.empty<number>()).toBe(ValueList.empty<number>());
    expect(ValueList.from([])).toBe(ValueList.empty<number>());
  });

  it('equal arrays are reference-identical', () => {
    const a = ValueList.of(1, 2, 3);
    const b = ValueList.of(1, 2, 3);
    expect(a).toBe(b);
  });

  it('different arrays are not identical', () => {
    expect(ValueList.of(1, 2, 3)).not.toBe(ValueList.of(1, 2, 4));
    expect(ValueList.of(1, 2, 3)).not.toBe(ValueList.of(3, 2, 1));
    expect(ValueList.of(1, 2)).not.toBe(ValueList.of(1, 2, 3));
  });

  it('exposes [hashCode] as a number property', () => {
    const a = ValueList.of(1, 2, 3);
    expect(typeof a[hashCode]).toBe('number');
    expect(a[hashCode]).toBe(ValueList.of(1, 2, 3)[hashCode]);
  });

  it('marks instances as [interned]', () => {
    expect(ValueList.of(1)[interned]).toBe(true);
    expect(ValueList.empty()[interned]).toBe(true);
  });

  it('push: incremental hash matches from-scratch', () => {
    const a = ValueList.of(1, 2, 3);
    const b = a.push(4);
    expect(b).toBe(ValueList.of(1, 2, 3, 4));
    expect(b[hashCode]).toBe(ValueList.of(1, 2, 3, 4)[hashCode]);
  });

  it('push: pool hit avoids new allocation', () => {
    const target = ValueList.of('x', 'y');
    const built = ValueList.of('x').push('y');
    expect(built).toBe(target);
  });

  it('pop: incremental hash matches from-scratch', () => {
    const a = ValueList.of(1, 2, 3, 4);
    const b = a.pop();
    expect(b).toBe(ValueList.of(1, 2, 3));
  });

  it('pop on empty returns this', () => {
    const e = ValueList.empty<number>();
    expect(e.pop()).toBe(e);
  });

  it('set: incremental hash matches from-scratch', () => {
    const a = ValueList.of('a', 'b', 'c');
    const b = a.set(1, 'B');
    expect(b).toBe(ValueList.of('a', 'B', 'c'));
  });

  it('set with same value returns this', () => {
    const a = ValueList.of(1, 2, 3);
    expect(a.set(1, 2)).toBe(a);
  });

  it('set out of range throws', () => {
    const a = ValueList.of(1, 2);
    expect(() => a.set(5, 9)).toThrow(RangeError);
    expect(() => a.set(-1, 9)).toThrow(RangeError);
  });

  it('get() reads by index; out of range is undefined', () => {
    const a = ValueList.of(10, 20, 30);
    expect(a.get(0)).toBe(10);
    expect(a.get(2)).toBe(30);
    expect(a.get(3)).toBeUndefined();
    expect(a.get(-1)).toBeUndefined();
    expect(a.get(1.5)).toBeUndefined();
    expect([...a]).toEqual([10, 20, 30]);
  });

  it('toArray() returns the interned frozen snapshot, memoized per instance', () => {
    const a = ValueList.of(1, 2, 3);
    const snap = a.toArray();
    expect(Array.isArray(snap)).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap).toEqual([1, 2, 3]);
    expect(a.toArray()).toBe(snap); // weakly memoized
    // Elements come back canonical — identical to what get() returns.
    const l = ValueList.of({ id: 1 });
    expect(l.toArray()[0]).toBe(l.get(0));
  });

  it('[equals] uses kind discriminator', () => {
    const a = ValueList.of(1);
    expect(a[equals](ValueList.of(1))).toBe(true);
    expect(a[equals]({})).toBe(false);
    expect(a[equals]([1])).toBe(false);
  });

  it('round-trip push/pop produces same instance', () => {
    const a = ValueList.of(1, 2, 3);
    expect(a.push(4).pop()).toBe(a);
  });

  it('NaN elements are SameValueZero (no canonical split, set is unchanged)', () => {
    const a = ValueList.of(NaN);
    expect(ValueList.of(NaN)).toBe(a);
    expect(a.set(0, NaN)).toBe(a);
    expect(a.get(0)).toBeNaN();
  });
});

describe('ValueList — hash-consed canonicality across the trunk/tail boundary', () => {
  const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('push construction equals from() at every size through two tree levels', () => {
    // Crosses: tail fill (32), first trunk leaf (33), root overflow to
    // height 1 (1025 needs > 32 leaves), and assorted interior sizes.
    const sizes = [1, 31, 32, 33, 63, 64, 65, 100, 1023, 1024, 1025, 1057, 2050];
    let built = ValueList.empty<number>();
    let n = 0;
    const max = Math.max(...sizes);
    const want = new Set(sizes);
    while (n < max) {
      built = built.push(n);
      n++;
      if (want.has(n)) {
        expect(built).toBe(ValueList.from(range(n)));
        expect(built.length).toBe(n);
      }
    }
  });

  it('pop walks back down the identical canonical instances', () => {
    let l = ValueList.from(range(1100));
    for (let n = 1100; n > 1090; n--) {
      l = l.pop();
      expect(l).toBe(ValueList.from(range(n - 1)));
    }
    // And across the height-collapse boundary.
    let m = ValueList.from(range(1025));
    m = m.pop();
    expect(m).toBe(ValueList.from(range(1024)));
  });

  it('set() detours in trunk and tail return to the same instance', () => {
    const base = ValueList.from(range(200));
    expect(base.set(5, 999).set(5, 5)).toBe(base); // trunk
    expect(base.set(199, 999).set(199, 199)).toBe(base); // tail
    expect(base.set(5, 5)).toBe(base); // unchanged write
    expect(base.get(5)).toBe(5);
    expect(base.set(5, 999).get(5)).toBe(999);
  });

  it('iteration and get() agree with a plain-array mirror at an awkward size', () => {
    const mirror = range(1057); // trunk 1056 (two levels), tail 1
    const l = ValueList.from(mirror);
    expect([...l]).toEqual(mirror);
    for (const i of [0, 31, 32, 1023, 1024, 1055, 1056]) {
      expect(l.get(i)).toBe(mirror[i]);
    }
  });

  it('deep equality between equal lists is instance identity', () => {
    const a = ValueList.from(range(500));
    let b = ValueList.empty<number>();
    for (const x of range(500)) b = b.push(x);
    expect(b).toBe(a);
  });
});

describe('ValueList — size sweep through three tree levels (> 1,024 elements)', () => {
  // The trunk grows a level at 32 and at 1,024 trunk elements, and pop must
  // collapse those levels back down. Walk every size across both boundaries
  // and compare the push-built and pop-walked instances with from() — the
  // canonical-form oracle — at each step.
  const N = 1_024 + 32 * 3 + 5; // two full levels, three more leaves, a partial tail

  it('push-chain === from() at every size up to N', () => {
    let list = ValueList.empty<number>();
    for (let n = 1; n <= N; n++) {
      list = list.push(n);
      expect(list.length).toBe(n);
      expect(list).toBe(ValueList.from(Array.from({ length: n }, (_, i) => i + 1)));
    }
  });

  it('pop walks back down through the level collapses onto the same instances', () => {
    const items = Array.from({ length: N }, (_, i) => i + 1);
    let list = ValueList.from(items);
    for (let n = N; n > 0; n--) {
      list = list.pop();
      expect(list.length).toBe(n - 1);
      expect(list).toBe(ValueList.from(items.slice(0, n - 1)));
    }
    expect(list).toBe(ValueList.empty());
  });

  it('get()/iteration agree with a plain array across both boundaries', () => {
    const items = Array.from({ length: N }, (_, i) => i * 3);
    const list = ValueList.from(items);
    for (let i = 0; i < N; i++) expect(list.get(i)).toBe(items[i]);
    expect([...list]).toEqual(items);
    expect(list.get(N)).toBeUndefined();
  });

  it('set() deep in the trunk at level 2 detours and returns', () => {
    const items = Array.from({ length: N }, (_, i) => i);
    const list = ValueList.from(items);
    for (const i of [0, 31, 32, 1_023, 1_024, 1_040, N - 1]) {
      const changed = list.set(i, -1);
      expect(changed).not.toBe(list);
      expect(changed.get(i)).toBe(-1);
      expect(changed.set(i, i)).toBe(list);
      const mirror = items.slice();
      mirror[i] = -1;
      expect(changed).toBe(ValueList.from(mirror));
    }
  });
});
