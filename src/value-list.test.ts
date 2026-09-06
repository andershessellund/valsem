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

// ---------------------------------------------------------------------------
// The content-chunked tree: edits, setMany, diff (property-tested against an array mirror)
// ---------------------------------------------------------------------------
import fc from 'fast-check';
import type { Hunk } from './value-list.js';
import { intern } from './intern.js';

const arrOf = (n: number, salt = 0) => Array.from({ length: n }, (_, i) => ({ id: i + salt * 1e6, tag: `t${i % 7}` }));

/** Apply hunks to `a` to reconstruct `b`. */
function applyHunks(a: readonly unknown[], b: readonly unknown[], hunks: Hunk[]): unknown[] {
  const out: unknown[] = [];
  let pos = 0;
  for (const h of hunks) {
    for (let i = pos; i < h.aStart; i++) out.push(a[i]);
    for (let i = h.bStart; i < h.bEnd; i++) out.push(b[i]);
    pos = h.aEnd;
  }
  for (let i = pos; i < a.length; i++) out.push(a[i]);
  return out;
}

describe('ValueList — canonical form (content-chunked tree)', () => {
  it('equal content is the same instance, however built', () => {
    for (const n of [0, 1, 5, 31, 32, 33, 64, 65, 100, 1000, 5000]) {
      const items = arrOf(n);
      const a = ValueList.from(items);
      expect(ValueList.from(items.map((x) => ({ ...x })))).toBe(a);
      let b = ValueList.empty<{ id: number; tag: string }>();
      for (const x of items) b = b.push(x);
      expect(b).toBe(a);
      expect(a.length).toBe(n);
      expect(a.toArray()).toEqual(items);
      expect([...a]).toEqual(items);
      for (let i = 0; i < n; i += Math.max(1, n >> 4)) expect(a.get(i)).toBe(intern(items[i]));
      expect(a.get(-1)).toBeUndefined();
      expect(a.get(n)).toBeUndefined();
    }
  });

  it('every edit lands on the canonical list for the resulting content', () => {
    const base = arrOf(2000);
    const list = ValueList.from<unknown>(base);
    const check = (l: ValueList<unknown>, expected: unknown[]) => {
      expect(l.toArray()).toEqual(expected);
      expect(l).toBe(ValueList.from(expected));
    };
    check(list.insert(0, { id: -1 }), [{ id: -1 }, ...base]);
    check(list.insert(1000, { id: -1 }), [...base.slice(0, 1000), { id: -1 }, ...base.slice(1000)]);
    check(list.insert(2000, { id: -1 }), [...base, { id: -1 }]);
    check(list.remove(0), base.slice(1));
    check(list.remove(1234), [...base.slice(0, 1234), ...base.slice(1235)]);
    check(list.remove(1999), base.slice(0, 1999));
    check(list.set(777, { id: -7 }), base.map((x, i) => (i === 777 ? { id: -7 } : x)));
    check(list.pop(), base.slice(0, -1));
    check(list.splice(500, 300, arrOf(10, 9)), [...base.slice(0, 500), ...arrOf(10, 9), ...base.slice(800)]);
    check(list.splice(0, 2000), []);
    check(list.slice(100, 900), base.slice(100, 900));
    check(list.slice(0, 2000), base);
    check(list.slice(1990), base.slice(1990));
    check(list.concat(ValueList.from<unknown>(arrOf(50, 3))), [...base, ...arrOf(50, 3)]);
    check(ValueList.from<unknown>(arrOf(50, 3)).concat(list), [...arrOf(50, 3), ...base]);
    check(ValueList.empty<unknown>().concat(list), base);
    expect(list.set(5, base[5]!)).toBe(list);
    expect(list.concat(ValueList.empty())).toBe(list);
  });
});

describe('ValueList — property: every operation agrees with an array mirror and stays canonical', () => {
  const item = fc.oneof(fc.integer({ min: 0, max: 50 }), fc.string({ maxLength: 3 }), fc.constant(NaN));
  const op = fc.oneof(
    fc.record({ kind: fc.constant('push' as const), v: item }),
    fc.record({ kind: fc.constant('pop' as const) }),
    fc.record({ kind: fc.constant('set' as const), i: fc.nat(), v: item }),
    fc.record({ kind: fc.constant('insert' as const), i: fc.nat(), v: item }),
    fc.record({ kind: fc.constant('remove' as const), i: fc.nat() }),
    fc.record({ kind: fc.constant('splice' as const), i: fc.nat(), del: fc.nat(5), items: fc.array(item, { maxLength: 5 }) }),
    fc.record({ kind: fc.constant('slice' as const), i: fc.nat(), j: fc.nat() }),
    fc.record({ kind: fc.constant('concat' as const), items: fc.array(item, { maxLength: 40 }) }),
  );
  it('holds over random operation sequences', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 200 }), fc.array(op, { maxLength: 40 }), (init, ops) => {
        let mirror: unknown[] = init.slice();
        let list = ValueList.from(init);
        for (const o of ops) {
          const n = mirror.length;
          switch (o.kind) {
            case 'push': mirror = [...mirror, o.v]; list = list.push(o.v); break;
            case 'pop': mirror = mirror.slice(0, -1); list = list.pop(); break;
            case 'set': if (n === 0) break; { const i = o.i % n; mirror = mirror.map((x, k) => (k === i ? o.v : x)); list = list.set(i, o.v); } break;
            case 'insert': { const i = o.i % (n + 1); mirror = [...mirror.slice(0, i), o.v, ...mirror.slice(i)]; list = list.insert(i, o.v); } break;
            case 'remove': if (n === 0) break; { const i = o.i % n; mirror = [...mirror.slice(0, i), ...mirror.slice(i + 1)]; list = list.remove(i); } break;
            case 'splice': { const i = o.i % (n + 1); mirror = [...mirror.slice(0, i), ...o.items, ...mirror.slice(i + o.del)]; list = list.splice(i, o.del, o.items); } break;
            case 'slice': { const i = o.i % (n + 1); const j = o.j % (n + 1); mirror = mirror.slice(i, j); list = list.slice(i, j); } break;
            case 'concat': mirror = [...mirror, ...o.items]; list = list.concat(ValueList.from(o.items)); break;
          }
          expect(list.length).toBe(mirror.length);
          expect(list.toArray()).toEqual(mirror);
          expect(list).toBe(ValueList.from(mirror)); // canonical after every step
        }
        for (let i = 0; i < mirror.length; i++) expect(list.get(i)).toBe(intern(mirror[i]));
        expect([...list]).toEqual(mirror);
      }),
      { numRuns: 300 },
    );
  });
});

describe('ValueList.setMany', () => {
  it('property: a batch of point edits equals the same edits one at a time, and is canonical', () => {
    const item = fc.oneof(fc.integer({ min: 0, max: 40 }), fc.string({ maxLength: 2 }));
    fc.assert(
      fc.property(
        fc.array(item, { minLength: 1, maxLength: 400 }),
        fc.array(fc.tuple(fc.nat(), item), { maxLength: 60 }),
        (init, raw) => {
          const list = ValueList.from<unknown>(init);
          const edits = raw.map(([i, v]) => [i % init.length, v] as [number, unknown]);
          const mirror: unknown[] = init.slice();
          for (const [i, v] of edits) mirror[i] = v;
          const batched = list.setMany(edits);
          expect(batched.toArray()).toEqual(mirror);
          expect(batched).toBe(ValueList.from(mirror));
          let oneByOne = list;
          for (const [i, v] of edits) oneByOne = oneByOne.set(i, v);
          expect(oneByOne).toBe(batched);
        },
      ),
      { numRuns: 300 },
    );
  });
  it('handles a wide list with edits in every leaf', () => {
    const init = Array.from({ length: 20000 }, (_, i) => i);
    const list = ValueList.from(init);
    const edits: [number, number][] = [];
    for (let i = 0; i < 20000; i += 3) edits.push([i, -i]);
    const mirror = init.slice();
    for (const [i, v] of edits) mirror[i] = v;
    expect(list.setMany(edits)).toBe(ValueList.from(mirror));
    expect(list.setMany([])).toBe(list);
    expect(list.setMany([[5, 5]])).toBe(list);
  });
});

describe('ValueList.diff', () => {
  it('reconstructs b from a, with one hunk per isolated edit', () => {
    const base = arrOf(5000);
    const a = ValueList.from<unknown>(base);
    expect(ValueList.diff(a, a)).toEqual([]);
    const b = a.set(1234, { id: -1 });
    const h = ValueList.diff(a, b);
    expect(h).toEqual([{ aStart: 1234, aEnd: 1235, bStart: 1234, bEnd: 1235 }]);
    const c = a.insert(10, { id: -2 }).remove(4000);
    const hc = ValueList.diff(a, c);
    expect(hc).toEqual([
      { aStart: 10, aEnd: 10, bStart: 10, bEnd: 11 },
      { aStart: 3999, aEnd: 4000, bStart: 4000, bEnd: 4000 }, // remove(4000) after the insert takes base[3999]
    ]);
    expect(applyHunks(a.toArray(), c.toArray(), hc)).toEqual(c.toArray());
    // unrelated builds: a refetch with three changed items
    const changed = base.map((x, i) => (i % 1700 === 5 ? { ...x, tag: 'changed' } : x));
    const d = ValueList.from(changed);
    const hd = ValueList.diff(a, d);
    expect(hd.length).toBe(3);
    expect(applyHunks(base, changed, hd)).toEqual(changed);
    expect(ValueList.diff(ValueList.empty(), a)).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 5000 }]);
    expect(ValueList.diff(a, ValueList.empty())).toEqual([{ aStart: 0, aEnd: 5000, bStart: 0, bEnd: 0 }]);
  });

  it('property: applying the hunks to a yields b', () => {
    const item = fc.oneof(fc.integer({ min: 0, max: 20 }), fc.string({ maxLength: 2 }));
    fc.assert(
      fc.property(fc.array(item, { maxLength: 300 }), fc.array(item, { maxLength: 300 }), (x, y) => {
        const a = ValueList.from(x);
        const b = ValueList.from(y);
        const hunks = ValueList.diff(a, b);
        expect(applyHunks(x, y, hunks)).toEqual(y);
        for (let i = 1; i < hunks.length; i++) {
          expect(hunks[i]!.aStart).toBeGreaterThanOrEqual(hunks[i - 1]!.aEnd);
          expect(hunks[i]!.bStart).toBeGreaterThanOrEqual(hunks[i - 1]!.bEnd);
        }
      }),
      { numRuns: 300 },
    );
  });
});
