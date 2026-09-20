// ---------------------------------------------------------------------------
// The roster is complete: every value type index.ts exports is enrolled in
// roster.test-helpers.ts, and so is under every law suite that runs over it.
//
// What counts is read off the exports rather than listed again here: a value
// type is an exported class whose prototype answers `[interned]`; a
// collection is one of those that is iterable; a draft type is an exported
// class named Draft*. Add a type to index.ts without enrolling it and this
// file fails, naming it.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import * as api from './index.js';
import { interned } from './deep-equal.js';
import { COLLECTIONS, VALUE_TYPES } from './roster.test-helpers.js';

type ExportedClass = Function & { prototype: object };
const exportedClasses = Object.entries(api as Record<string, unknown>).filter(
  (e): e is [string, ExportedClass] =>
    typeof e[1] === 'function' && typeof (e[1] as { prototype?: unknown }).prototype === 'object' && /^[A-Z]/.test(e[0]),
);
const valueTypes = exportedClasses.filter(([, c]) => interned in c.prototype);
const names = (entries: readonly (readonly [string, unknown])[]): string[] => entries.map(([name]) => name).sort();

describe('the roster covers what index.ts exports', () => {
  it('finds the value types by their marker (a guard on the derivation itself)', () => {
    expect(names(valueTypes)).toContain('ValueList');
    expect(names(valueTypes)).not.toContain('HashMap'); // mutable: holds values, is not one
  });

  it('every exported value type is enrolled, under its exported name', () => {
    expect(VALUE_TYPES.map((t) => t.name).sort()).toEqual(names(valueTypes));
    for (const t of VALUE_TYPES) expect((api as Record<string, unknown>)[t.name], t.name).toBe(t.type);
  });

  it('every iterable one is enrolled as a collection', () => {
    const iterable = valueTypes.filter(([, c]) => Symbol.iterator in c.prototype);
    expect(COLLECTIONS.map((c) => c.name).sort()).toEqual(names(iterable));
  });

  it('every exported draft type is some collection’s draft', () => {
    const drafts = exportedClasses.filter(([name]) => name.startsWith('Draft'));
    expect(new Set(drafts.map(([, c]) => c))).toEqual(new Set(COLLECTIONS.map((c) => c.draftType)));
    expect(drafts.length).toBe(COLLECTIONS.length);
  });

  it('each entry builds what it says it builds', () => {
    for (const t of VALUE_TYPES) expect(t.sample(), t.name).toBeInstanceOf(t.type);
    for (const c of COLLECTIONS) {
      expect(c.of('a', 'b'), c.name).toBeInstanceOf(c.type);
      expect(c.chained('a', 'b'), c.name).toBe(c.of('a', 'b'));
      expect(c.add(c.of('a'), 'b'), c.name).toBe(c.of('a', 'b'));
      // Read back in order only where order is part of the value.
      const expected = c.keyed ? ['a', 'b', 'a', 'b'] : ['a', 'b'];
      const stored = c.contents(c.of('a', 'b'));
      expect(c.ordered ? stored : stored.sort(), c.name).toEqual(c.ordered ? expected : expected.sort());
      expect(c.has(c.of('a'), 'a') && !c.has(c.of('a'), 'b'), c.name).toBe(true);
      expect(c.of(), c.name).toBe(c.empty());
    }
  });
});
