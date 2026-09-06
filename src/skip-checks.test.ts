// Runs in its own worker: skipChecks() is one-way and process-global.
import { describe, it, expect } from 'vitest';
import { skipChecks } from './checks.js';
import { intern, fastEquals } from './intern.js';
import { HashMap } from './hash-map.js';

skipChecks();

describe('after skipChecks()', () => {
  it('fastEquals is a bare === — a raw argument is no longer caught', () => {
    const c = intern({ x: 1 });
    expect(fastEquals(c, c)).toBe(true);
    expect(fastEquals({ x: 1 }, c)).toBe(false); // the silent answer the check existed to prevent
    expect(fastEquals(() => 1, 2)).toBe(false);
  });
  it('HashMap.getCanonical trusts its key', () => {
    const m = new HashMap<{ id: number }, string>();
    m.set({ id: 1 }, 'v');
    expect(m.getCanonical({ id: 1 })).toBeUndefined(); // a raw key misses, silently
    expect(m.getCanonical(intern({ id: 1 }))).toBe('v');
  });
  it('does not touch semantics: values are still frozen, non-values still rejected', () => {
    expect(Object.isFrozen(intern({ a: [1] }))).toBe(true);
    expect(() => intern(new Date())).toThrow(/cannot be interned/);
  });
});
