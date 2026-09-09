// `valsem/binding` — the semver-covered surface for binding authors.
import { describe, it, expect } from 'vitest';
import { defineRecordField, mutableBuiltinReason } from './binding.js';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';

describe('valsem/binding', () => {
  it('exports exactly the two documented functions', () => {
    expect(typeof defineRecordField).toBe('function');
    expect(typeof mutableBuiltinReason).toBe('function');
  });

  it('mutableBuiltinReason names the replacement for each refused built-in, and nothing else', () => {
    expect(mutableBuiltinReason(Date)).toMatch(/Temporal\.Instant/);
    expect(mutableBuiltinReason(RegExp)).toMatch(/source, flags/);
    expect(mutableBuiltinReason(Map)).toMatch(/ValueMap\.from/);
    expect(mutableBuiltinReason(Set)).toMatch(/ValueSet\.from/);
    expect(mutableBuiltinReason(Uint8Array)).toMatch(/hex or base64/);
    expect(mutableBuiltinReason(ArrayBuffer)).toMatch(/hex or base64/);
    expect(mutableBuiltinReason(DataView)).toMatch(/hex or base64/);
    class Plain {}
    expect(mutableBuiltinReason(Plain)).toBeUndefined();
    expect(mutableBuiltinReason(Object)).toBeUndefined();
    expect(mutableBuiltinReason(undefined)).toBeUndefined();
  });

  it('mutableBuiltinReason tells the same story deepHash does', () => {
    expect(() => deepHash(new Date(0))).toThrow(mutableBuiltinReason(Date)!);
    expect(() => deepHash(new Map())).toThrow(mutableBuiltinReason(Map)!);
  });

  it('defineRecordField writes __proto__ as an own data property', () => {
    const out: Record<string, unknown> = {};
    defineRecordField(out, '__proto__', { isAdmin: true });
    defineRecordField(out, 'a', 1);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'a']);
    expect((out as { isAdmin?: unknown }).isAdmin).toBeUndefined();
    // …and the result is an ordinary record to the rest of the package.
    expect(deepEqual(out, JSON.parse('{"a":1,"__proto__":{"isAdmin":true}}'))).toBe(true);
  });
});
