// Runs in its own worker: skipChecks() is one-way and process-global.
import { describe, it, expect } from 'vitest';
import { skipChecks } from './checks.js';
import { intern, fastEqual } from './intern.js';

skipChecks();

describe('after skipChecks()', () => {
  it('fastEqual is a bare === — a raw argument is no longer caught', () => {
    const c = intern({ x: 1 });
    expect(fastEqual(c, c)).toBe(true);
    expect(fastEqual({ x: 1 }, c)).toBe(false); // the silent answer the check existed to prevent
    expect(fastEqual(() => 1, 2)).toBe(false);
  });
  it('does not touch semantics: values are still frozen, non-values still rejected', () => {
    expect(Object.isFrozen(intern({ a: [1] }))).toBe(true);
    expect(() => intern(new Date())).toThrow(/cannot be interned/);
  });
});
