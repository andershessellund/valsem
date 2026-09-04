// The development expectation guard: deepEqual's reference-semantics answer
// for two distinct mutable-builtin instances is CORRECT (substitutability)
// but famously surprising — so in development it warns, once per type, with
// the teaching text. Loud without throwing. This file relies on per-file
// process isolation for a clean warned-type set.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepEqual, _resetEqualityWarnings } from './deep-equal.js';

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  warn.mockClear();
  _resetEqualityWarnings();
});

describe('deepEqual — development expectation warnings', () => {
  it('warns once per type for distinct mutable-builtin pairs', () => {
    expect(deepEqual(new Set(), new Set())).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/Set instances/);
    expect(warn.mock.calls[0]![0]).toMatch(/ValueSet\.from/); // teaching text

    // Same type again: silent.
    expect(deepEqual(new Set([1]), new Set([1]))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    // A different mutable type gets its own single warning.
    expect(deepEqual(new Date(0), new Date(0))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toMatch(/Temporal\.Instant/);
  });

  it('does not warn for identical instances or cross-kind pairs', () => {
    const s = new Set([1]);
    expect(deepEqual(s, s)).toBe(true);
    expect(deepEqual(new Set(), new Map())).toBe(false);
    expect(deepEqual(new Date(0), { at: 0 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for plain data or user class instances', () => {
    class Svc {
      constructor(readonly name: string) {}
    }
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual(new Svc('x'), new Svc('x'))).toBe(false); // reference semantics, intended
    expect(warn).not.toHaveBeenCalled();
  });

  it('nested mutable builtins warn too (the record comparison recurses into them)', () => {
    expect(deepEqual({ tags: new Set([1]) }, { tags: new Set([1]) })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
