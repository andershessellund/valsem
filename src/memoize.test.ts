import { describe, it, expect, vi } from 'vitest';
import { memoize } from './memoize.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';
import { ValueDate } from './value-date.js';

describe('memoize', () => {
  it('runs once per distinct argument tuple, by value', () => {
    const fn = vi.fn((a: { x: number }, b: number[]) => a.x + b.length);
    const m = memoize(fn, { maxSize: 4 });
    expect(m({ x: 1 }, [1, 2])).toBe(3);
    expect(m({ x: 1 }, [1, 2])).toBe(3); // structurally equal, fresh objects
    expect(m(intern({ x: 1 }), intern([1, 2]))).toBe(3); // canonical spellings of the same
    expect(fn).toHaveBeenCalledTimes(1);
    expect(m({ x: 2 }, [1, 2])).toBe(4);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(m.size).toBe(2);
  });

  it('arity is part of the key', () => {
    const fn = vi.fn((...args: number[]) => args.length);
    const m = memoize(fn, { maxSize: 4 });
    expect(m(1)).toBe(1);
    expect(m(1, undefined as unknown as number)).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('results are interned: equal calls return the same instance, and so do equal results', () => {
    const m = memoize((n: number) => ({ list: [n, n + 1] }), { maxSize: 4 });
    const a = m(1);
    expect(m(1)).toBe(a);
    expect(a).toBe(intern({ list: [1, 2] }));
    expect(Object.isFrozen(a)).toBe(true);
    const dateOf = memoize((s: string) => ValueDate.of(s));
    expect(dateOf('2026-09-06T00:00:00Z')).toBe(ValueDate.of('2026-09-06T00:00:00Z'));
  });

  it('caches undefined results, and never a throw', () => {
    const fn = vi.fn((k: string) => (k === 'boom' ? (() => { throw new Error('boom'); })() : undefined));
    const m = memoize(fn, { maxSize: 4 });
    expect(m('a')).toBeUndefined();
    expect(m('a')).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => m('boom')).toThrow('boom');
    expect(() => m('boom')).toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(m.size).toBe(1);
  });

  it('evicts least-recently-used; a hit refreshes recency', () => {
    const fn = vi.fn((n: number) => n * 2);
    const m = memoize(fn, { maxSize: 2 });
    m(1);
    m(2);
    m(1); // 1 is now the most recent
    m(3); // evicts 2
    expect(fn).toHaveBeenCalledTimes(3);
    m(1); // hit
    expect(fn).toHaveBeenCalledTimes(3);
    m(2); // miss again
    expect(fn).toHaveBeenCalledTimes(4);
    expect(m.size).toBe(2);
  });

  it('default size is 1 — the last call', () => {
    const fn = vi.fn((n: number) => n);
    const m = memoize(fn);
    m(1);
    m(1);
    m(2);
    m(1);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(m.size).toBe(1);
  });

  it('Infinity keeps everything; clear() empties', () => {
    const fn = vi.fn((n: number) => n);
    const m = memoize(fn, { maxSize: Infinity });
    for (let i = 0; i < 50; i++) m(i);
    for (let i = 0; i < 50; i++) m(i);
    expect(fn).toHaveBeenCalledTimes(50);
    expect(m.size).toBe(50);
    m.clear();
    expect(m.size).toBe(0);
    m(0);
    expect(fn).toHaveBeenCalledTimes(51);
  });

  it('validates maxSize', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => memoize((n: number) => n, { maxSize: bad })).toThrow(/positive integer or Infinity/);
    }
  });

  it('hash collisions between different argument tuples are handled', () => {
    // Force every tuple into one bucket by memoizing over a single argument
    // whose hash we cannot control — instead assert correctness across many
    // distinct keys, which exercises bucket arrays whenever the 30-bit hash
    // collides, and always the multi-key path.
    const m = memoize((s: string) => s.length, { maxSize: Infinity });
    for (let i = 0; i < 5000; i++) expect(m(`key-${i}`)).toBe(`key-${i}`.length);
    expect(m.size).toBe(5000);
    for (let i = 0; i < 5000; i++) expect(m(`key-${i}`)).toBe(`key-${i}`.length);
    expect(m.size).toBe(5000);
  });

  it('this is passed through but not part of the key', () => {
    const fn = vi.fn(function (this: { k: number }, n: number) {
      return this.k + n;
    });
    const m = memoize(fn, { maxSize: 4 });
    expect(m.call({ k: 10 }, 1)).toBe(11);
    expect(m.call({ k: 20 }, 1)).toBe(11); // same arguments: cached, this ignored
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects non-value arguments with a teaching error', () => {
    const m = memoize((...args: unknown[]) => args.length, { maxSize: 4 });
    expect(() => m(() => 1)).toThrow(/memoize — an argument of the function is not a value \(deepHash: function is not supported\)/);
    expect(() => m(new Date())).toThrow(/is not a value/);
    expect(() => m(new Map())).toThrow(/is not a value/);
    class Foo {}
    expect(() => m(new Foo())).toThrow(/is not a value/);
  });

  it('rejects non-value results', () => {
    class Box {
      constructor(public n: number) {}
    }
    const boxes = memoize(function makeBox(n: number) {
      return new Box(n);
    });
    expect(() => boxes(1)).toThrow(/memoize — makeBox returned an instance of Box, which is not a value/);
    const fns = memoize((n: number) => () => n);
    expect(() => fns(1)).toThrow(/returned a function, which is not a value/);
    expect(() => memoize((n: number) => new Date(n))(0)).toThrow(/cannot be interned/);
  });

  it('symbols are values here too', () => {
    const fn = vi.fn((kind: symbol, n: number) => ({ kind, n }));
    const m = memoize(fn, { maxSize: 4 });
    const s = Symbol('s');
    expect(m(s, 1)).toBe(m(s, 1));
    expect(m(Symbol.for('r'), 1)).toBe(m(Symbol.for('r'), 1));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(m(s, 1)[Symbol.for('x') as never]).toBeUndefined();
  });

  it('the recommended shape: canonical state in, canonical result out', () => {
    const todos = ValueList.of(
      { text: 'a', done: true },
      { text: 'b', done: false },
      { text: 'c', done: true },
    );
    const fn = vi.fn((list: ValueList<{ text: string; done: boolean }>, filter: { done: boolean }) =>
      list.toArray().filter((t) => t.done === filter.done).map((t) => t.text),
    );
    const visible = memoize(fn, { maxSize: 8 });
    const first = visible(todos, { done: true });
    expect(first).toEqual(['a', 'c']);
    expect(visible(todos, { done: true })).toBe(first); // a fresh filter literal — same value, same instance
    expect(visible(todos.push({ text: 'd', done: true }), { done: true })).toEqual(['a', 'c', 'd']);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
