// ---------------------------------------------------------------------------
// HashMap — tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { HashMap } from './hash-map.js';
import { intern } from './intern.js';

describe('HashMap', () => {
  // --- Basic CRUD ---

  it('stores and retrieves by structural key', () => {
    const map = new HashMap<{ id: number }, string>();
    map.set({ id: 1 }, 'one');
    map.set({ id: 2 }, 'two');

    expect(map.get({ id: 1 })).toBe('one');
    expect(map.get({ id: 2 })).toBe('two');
    expect(map.get({ id: 3 })).toBeUndefined();
  });

  it('treats structurally equal keys as the same entry', () => {
    const map = new HashMap<{ a: number; b: number }, string>();
    map.set({ a: 1, b: 2 }, 'first');
    map.set({ b: 2, a: 1 }, 'second'); // same key, different order

    expect(map.size).toBe(1);
    expect(map.get({ a: 1, b: 2 })).toBe('second');
  });

  it('has() returns correct boolean', () => {
    const map = new HashMap<number[], boolean>();
    map.set([1, 2], true);

    expect(map.has([1, 2])).toBe(true);
    expect(map.has([1, 3])).toBe(false);
    expect(map.has([1])).toBe(false);
  });

  it('delete() removes entry', () => {
    const map = new HashMap<{ id: number }, string>();
    map.set({ id: 1 }, 'one');
    map.set({ id: 2 }, 'two');

    expect(map.delete({ id: 1 })).toBe(true);
    expect(map.size).toBe(1);
    expect(map.has({ id: 1 })).toBe(false);
    expect(map.has({ id: 2 })).toBe(true);
  });

  it('delete() returns false for missing key', () => {
    const map = new HashMap<string, number>();
    expect(map.delete('missing')).toBe(false);
  });

  // --- Size tracking ---

  it('tracks size correctly', () => {
    const map = new HashMap<string, number>();
    expect(map.size).toBe(0);

    map.set('a', 1);
    expect(map.size).toBe(1);

    map.set('b', 2);
    expect(map.size).toBe(2);

    map.set('a', 10); // overwrite
    expect(map.size).toBe(2);

    map.delete('a');
    expect(map.size).toBe(1);
  });

  it('clear() removes all entries', () => {
    const map = new HashMap<number, string>();
    map.set(1, 'a');
    map.set(2, 'b');

    map.clear();
    expect(map.size).toBe(0);
    expect(map.has(1)).toBe(false);
  });

  // --- getOrCreate ---

  it('getOrCreate() returns existing value without calling factory', () => {
    const map = new HashMap<{ id: number }, string>();
    map.set({ id: 1 }, 'existing');

    let factoryCalled = false;
    const result = map.getOrCreate({ id: 1 }, () => {
      factoryCalled = true;
      return 'new';
    });

    expect(result).toBe('existing');
    expect(factoryCalled).toBe(false);
    expect(map.size).toBe(1);
  });

  it('getOrCreate() creates, caches, and returns new value', () => {
    const map = new HashMap<{ id: number }, string>();

    const result = map.getOrCreate({ id: 1 }, (key) => `created-${key.id}`);

    expect(result).toBe('created-1');
    expect(map.size).toBe(1);
    expect(map.get({ id: 1 })).toBe('created-1');
  });

  // --- Iteration ---

  it('getOrCreate() caches an undefined result — the factory runs once', () => {
    const map = new HashMap<{ id: number }, number | undefined>();
    let calls = 0;
    const factory = (): undefined => {
      calls++;
      return undefined;
    };
    expect(map.getOrCreate({ id: 1 }, factory)).toBeUndefined();
    expect(map.getOrCreate({ id: 1 }, factory)).toBeUndefined();
    expect(map.getOrCreate({ id: 1 }, factory)).toBeUndefined();
    expect(calls).toBe(1);
    expect(map.size).toBe(1);
    expect(map.has({ id: 1 })).toBe(true);
  });

  it('getOrCreate() hands the factory the canonical key', () => {
    const map = new HashMap<{ id: number }, object>();
    const raw = { id: 7 };
    const seen = map.getOrCreate(raw, (k) => k);
    expect(seen).not.toBe(raw);
    expect(seen).toBe(intern(raw));
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('getCanonical() hits on a canonical key; a raw key is caught while checks are on', () => {
    const map = new HashMap<{ id: number }, string>();
    map.set({ id: 1 }, 'v');
    expect(map.getCanonical(intern({ id: 1 }))).toBe('v');
    // No intern call — a raw key would silently miss, so the promise is verified
    // (skip-checks.test.ts shows the silent miss once skipChecks() is called).
    expect(() => map.getCanonical({ id: 1 })).toThrow(/takes a canonical key/);
  });

  it('iteration yields canonical keys, not the caller\'s objects', () => {
    const map = new HashMap<{ id: number }, string>();
    const k = { id: 1 };
    map.set(k, 'v');
    const [yielded] = [...map.keys()];
    expect(yielded).not.toBe(k);
    expect(yielded).toBe(intern(k));
  });

  it('entries() yields all key-value pairs', () => {
    const map = new HashMap<string, number>();
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);

    const entries = [...map.entries()];
    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual(['a', 1]);
    expect(entries).toContainEqual(['b', 2]);
    expect(entries).toContainEqual(['c', 3]);
  });

  it('keys() yields all keys', () => {
    const map = new HashMap<string, number>();
    map.set('a', 1);
    map.set('b', 2);

    const keys = [...map.keys()];
    expect(keys).toHaveLength(2);
    expect(keys).toContain('a');
    expect(keys).toContain('b');
  });

  it('values() yields all values', () => {
    const map = new HashMap<string, number>();
    map.set('a', 1);
    map.set('b', 2);

    const values = [...map.values()];
    expect(values).toHaveLength(2);
    expect(values).toContain(1);
    expect(values).toContain(2);
  });

  it('is iterable via for...of', () => {
    const map = new HashMap<string, number>();
    map.set('x', 10);
    map.set('y', 20);

    const collected: [string, number][] = [];
    for (const entry of map) {
      collected.push(entry);
    }

    expect(collected).toHaveLength(2);
  });

  it('forEach() visits all entries', () => {
    const map = new HashMap<string, number>();
    map.set('a', 1);
    map.set('b', 2);

    const visited: [string, number][] = [];
    map.forEach((value, key) => {
      visited.push([key, value]);
    });

    expect(visited).toHaveLength(2);
  });

  // --- Complex keys ---

  it('supports nested object keys', () => {
    const map = new HashMap<{ filter: { status: string; limit: number } }, string>();

    map.set({ filter: { status: 'active', limit: 10 } }, 'result');

    expect(map.get({ filter: { limit: 10, status: 'active' } })).toBe('result');
  });

  it('supports array keys', () => {
    const map = new HashMap<number[], string>();
    map.set([1, 2, 3], 'a');
    map.set([4, 5, 6], 'b');

    expect(map.get([1, 2, 3])).toBe('a');
    expect(map.get([4, 5, 6])).toBe('b');
    expect(map.get([1, 2])).toBeUndefined();
  });
});
