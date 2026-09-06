// Runs in its own worker: skipChecks() is one-way and process-global.
import { describe, it, expect } from 'vitest';
import { skipChecks } from './checks.js';
import { intern, fastEquals } from './intern.js';
import { FastMap, FastSet } from './fast-collections.js';

skipChecks();

describe('after skipChecks()', () => {
  it('fastEquals is a bare === — a raw argument is no longer caught', () => {
    const c = intern({ x: 1 });
    expect(fastEquals(c, c)).toBe(true);
    expect(fastEquals({ x: 1 }, c)).toBe(false); // the silent answer the check existed to prevent
    expect(fastEquals(() => 1, 2)).toBe(false);
  });
  it('new FastMap() / new FastSet() ARE the native classes', () => {
    const m = new FastMap<unknown, string>([[intern({ id: 1 }), 'v']]);
    expect(m.constructor).toBe(Map); // the constructor handed back a plain Map
    expect(m).not.toBeInstanceOf(FastMap);
    expect(m.get(intern({ id: 1 }))).toBe('v');
    expect(m.get({ id: 1 })).toBeUndefined(); // a raw key misses, silently — the check is gone
    m.set({ id: 2 }, 'raw'); // and is accepted
    expect(m.size).toBe(2);
    const s = new FastSet([1, 2]);
    expect(s.constructor).toBe(Set);
    expect(s.has(1)).toBe(true);
  });
  it('does not touch semantics: values are still frozen, non-values still rejected', () => {
    expect(Object.isFrozen(intern({ a: [1] }))).toBe(true);
    expect(() => intern(new Date())).toThrow(/cannot be interned/);
  });
});
