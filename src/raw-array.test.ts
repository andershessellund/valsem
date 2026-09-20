import { describe, it, expect } from 'vitest';
import { RawArray } from './raw-array.js';
import { intern, isCanonical, fastEqual, _internPoolSize } from './intern.js';
import { deepEqual } from './deep-equal.js';
import { produce } from './produce.js';
import { ValueList } from './value-list.js';

const rows = (n: number, salt = 0) => Array.from({ length: n }, (_, i) => ({ id: i, name: `user-${i}`, tag: `t${(i + salt) % 5}` }));

describe('RawArray', () => {
  it('admits only what is sliced, once, and slices are canonical arrays', () => {
    const view = RawArray.from(rows(10_000));
    const before = _internPoolSize();
    const window = view.slice(100, 200);
    const after = _internPoolSize();
    expect(window.length).toBe(100);
    expect(after - before).toBeLessThanOrEqual(100 + 1); // 100 records (+ the slice array), not 10,000
    expect(isCanonical(window)).toBe(true);
    expect(window[0]).toBe(intern({ id: 100, name: 'user-100', tag: 't0' }));
    expect(view.slice(100, 200)).toBe(window); // same content, same array
    expect(view.at(150)).toBe(window[50]); // and the same element object
    expect(_internPoolSize()).toBe(after); // the second slice admitted nothing new
  });

  it('a refetch\'s unchanged rows are === to the previous view\'s', () => {
    const first = RawArray.from(rows(1000));
    const a = first.slice(0, 50);
    const changed = RawArray.from(rows(1000, 3)); // every tag differs
    const b = changed.slice(0, 50);
    expect(b).not.toBe(a);
    const same = RawArray.from(rows(1000)); // an unchanged refetch
    const c = same.slice(0, 50);
    expect(c).toBe(a); // the whole slice is the same canonical array
    for (let i = 0; i < 50; i++) expect(c[i]).toBe(a[i]);
  });

  it('at, bounds, negative indices, holes, and length', () => {
    const holey: unknown[] = [1];
    holey[2] = 3; // a hole at index 1
    const view = RawArray.from(holey);
    expect(view.length).toBe(3);
    expect(view.at(1)).toBeUndefined(); // a hole is an element, and it is undefined
    expect(view.at(3)).toBeUndefined(); // no element there, as Array.prototype.at
    expect(view.at(-1)).toBe(3);
    expect(view.at(-4)).toBeUndefined();
    expect(view.slice(-2)).toBe(intern([undefined, 3]));
    expect(view.slice(1, 100)).toBe(intern([undefined, 3]));
    expect(view.slice(5, 2)).toBe(intern([]));
    expect(view.slice()).toBe(intern([1, undefined, 3]));
  });

  it('owns its array: mutating the caller\'s array afterwards changes nothing', () => {
    const arr = rows(5);
    const view = RawArray.from(arr);
    arr[0] = { id: 99, name: 'x', tag: 'y' };
    arr.length = 1;
    expect(view.length).toBe(5);
    expect(view.at(0)).toBe(intern({ id: 0, name: 'user-0', tag: 't0' }));
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('is an opaque leaf inside canonical state: identity is its value', () => {
    const view = RawArray.from(rows(100));
    const other = RawArray.from(rows(100));
    expect(isCanonical(view)).toBe(true);
    expect(deepEqual(view, other)).toBe(false); // two views are two values
    expect(fastEqual(view, view)).toBe(true);
    const state = intern({ page: 2, rows: view });
    expect(state.rows).toBe(view); // passed through, not materialised
    expect(intern({ rows: view, page: 2 })).toBe(state);
    expect(intern({ rows: other, page: 2 })).not.toBe(state);
    const next = produce(state, (d) => {
      d.page = 3;
    });
    expect(next.rows).toBe(view);
    expect(_internPoolSize()).toBeGreaterThan(0);
  });

  it('slice() with no arguments admits everything; toJSON and ValueList.from go through it', () => {
    const view = RawArray.from(rows(20));
    expect(view.slice()).toBe(intern(rows(20)));
    expect(JSON.stringify({ rows: view })).toBe(JSON.stringify({ rows: rows(20) }));
    expect(ValueList.from(view.slice())).toBe(ValueList.from(rows(20)));
  });
});

describe('RawArray.from — anything iterable or array-like', () => {
  it('takes a Set, a generator and an array-like, and copies an array it is given', () => {
    function* rowsOf(): Generator<{ id: number }> {
      yield { id: 1 };
      yield { id: 2 };
    }
    for (const source of [new Set([{ id: 1 }, { id: 2 }]), rowsOf(), { length: 2, 0: { id: 1 }, 1: { id: 2 } }]) {
      const view = RawArray.from<{ id: number }>(source as Iterable<{ id: number }>);
      expect(view.length).toBe(2);
      expect(view.at(1)).toBe(intern({ id: 2 }));
      expect(view.slice()).toBe(intern([{ id: 1 }, { id: 2 }]));
    }
    const mine = [{ id: 1 }];
    const view = RawArray.from(mine);
    mine.push({ id: 2 }); // the caller's array, afterwards: not the view's
    expect(view.length).toBe(1);
  });
});
