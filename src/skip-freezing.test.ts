// Runs in its own worker: skipFreezing() is one-way and process-global.
import { describe, it, expect } from 'vitest';
import { skipFreezing } from './checks.js';
import { intern, isCanonical, fastEquals } from './intern.js';
import { produce } from './produce.js';
import { deepEqual } from './deep-equal.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueDate } from './value-date.js';
import { HashMap } from './hash-map.js';
import { memoize } from './memoize.js';

const frozenBefore = intern({ before: [1, 2] });
skipFreezing();

describe('after skipFreezing()', () => {
  it('plain canonical data is no longer frozen; what was frozen before stays frozen', () => {
    const c = intern({ a: [1, 2, 3], b: { c: 1 } });
    expect(Object.isFrozen(c)).toBe(false);
    expect(Object.isFrozen(c.a)).toBe(false);
    expect(Object.isFrozen(c.b)).toBe(false);
    expect(Object.isFrozen(frozenBefore)).toBe(true);
    expect(Object.isFrozen(produce(c, (d) => void d.a.push(4)))).toBe(false);
  });

  it('collections and value types still freeze their own instances', () => {
    expect(Object.isFrozen(ValueList.of(1))).toBe(true);
    expect(Object.isFrozen(ValueMap.from([[1, 1]]))).toBe(true);
    expect(Object.isFrozen(ValueDate.of(0))).toBe(true);
  });

  it('canonicality, hash-consing, equality and fastEquals are unaffected', () => {
    const a = intern({ x: [1, { y: 2 }] });
    expect(intern({ x: [1, { y: 2 }] })).toBe(a);
    expect(isCanonical(a)).toBe(true);
    expect(isCanonical(a.x)).toBe(true);
    expect(deepEqual(a, intern({ x: [1, { y: 2 }] }))).toBe(true);
    expect(fastEquals(a, intern({ x: [1, { y: 2 }] }))).toBe(true);
    expect(() => fastEquals(a, { x: 1 })).toThrow(/raw object/); // checks are a separate switch
    const m = new HashMap<object, number>();
    m.set(a, 1);
    expect(m.getCanonical(a)).toBe(1);
    expect(memoize((v: { x: unknown[] }) => v.x.length)(a)).toBe(2);
  });

  it('drafts still copy-on-write through an assigned canonical instead of mutating it', () => {
    const base = intern({ b: { n: 1 }, arr: [{ n: 1 }], c: null as unknown });
    const next = produce(base, (d) => {
      d.c = base.b; // unfrozen canonical assigned into the draft
      (d.c as { n: number }).n = 2; // must copy-on-write, not write into base.b
    });
    expect(base.b.n).toBe(1);
    expect((next.c as { n: number }).n).toBe(2);
    expect(next.b).toBe(base.b);

    const list = ValueList.of({ n: 1 });
    const item = list.get(0)!;
    const bumped = produce(ValueList.of({ n: 9 }), (d) => {
      d.set(0, item); // canonical from another list
      d.get(0)!.n = 5;
    });
    expect(item.n).toBe(1);
    expect(bumped.get(0)!.n).toBe(5);

    const map = ValueMap.from([['k', { n: 1 }]]);
    const v = map.get('k')!;
    const mapped = produce(ValueMap.from([['k', { n: 9 }]]), (d) => {
      d.set('k', v);
      d.get('k')!.n = 7;
    });
    expect(v.n).toBe(1);
    expect(mapped.get('k')!.n).toBe(7);

    const arrBase = intern({ arr: [{ n: 1 }, { n: 2 }] });
    const el = arrBase.arr[0]!;
    const arrNext = produce(intern({ arr: [{ n: 9 }] }), (d) => {
      d.arr[0] = el;
      d.arr[0]!.n = 3;
    });
    expect(el.n).toBe(1);
    expect(arrNext.arr[0]!.n).toBe(3);
  });

  it('the price: a mutation of a canonical value is no longer caught', () => {
    const c = intern({ mutable: [1] });
    expect(() => {
      c.mutable.push(2); // would throw when frozen
    }).not.toThrow();
    expect(c.mutable).toEqual([1, 2]); // and every holder now sees it — the documented trade
  });
});
