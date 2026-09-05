// Intern-on-entry: everything stored in a Value* collection is a canonical
// value (or primitive) BY CONSTRUCTION — an invariant, not a convention.
//
// This is what makes structural convergence hold for locally built
// collections (not just wire-decoded ones), closes the mutation-poisoning
// hazard (raw plain data is frozen at the door), and restores the
// cross-representation unity toArray() === intern([...contents]).
import { describe, it, expect } from 'vitest';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { intern } from './intern.js';
import { deepEqual } from './deep-equal.js';

describe('intern on entry — structural convergence for raw inputs', () => {
  it('lists of structurally equal raw objects are the same instance', () => {
    const a = ValueList.of({ city: 'Aarhus', zip: '8000' });
    const b = ValueList.of({ zip: '8000', city: 'Aarhus' });
    expect(a).toBe(b);
  });

  it('maps with structurally equal raw keys and values converge', () => {
    const a = ValueMap.from([[{ id: 1 }, { name: 'x' }]]);
    const b = ValueMap.from([[{ id: 1 }, { name: 'x' }]]);
    expect(a).toBe(b);
    expect(deepEqual(a, b)).toBe(true);
  });

  it('sets of structurally equal raw members converge', () => {
    expect(ValueSet.from([{ p: 1 }, { p: 2 }])).toBe(ValueSet.from([{ p: 2 }, { p: 1 }]));
  });

  it('nested raw data is canonicalized recursively', () => {
    const l = ValueList.of({ user: { id: 7 } });
    const stored = l.get(0)!;
    expect(stored).toBe(intern({ user: { id: 7 } }));
    expect((stored as { user: object }).user).toBe(intern({ id: 7 }));
  });
});

describe('intern on entry — the mutation hazard is closed', () => {
  it('raw plain data is frozen at the door', () => {
    const raw: { a: number } = { a: 1 };
    const l = ValueList.of(raw);
    const stored = l.get(0)!;
    expect(Object.isFrozen(stored)).toBe(true);
    // Strict mode: writing to a frozen object throws instead of silently
    // corrupting the cached hashes.
    expect(() => {
      stored.a = 2;
    }).toThrow(TypeError);
    // The list built from "the same" content is still the same instance.
    expect(ValueList.of({ a: 1 })).toBe(l);
  });
});

describe('intern on entry — probes are canonicalized', () => {
  it('map get/has/delete accept any structurally equal key', () => {
    const m = ValueMap.empty<object, string>().set({ table: 'users', id: 1 }, 'row');
    expect(m.get({ id: 1, table: 'users' })).toBe('row');
    expect(m.has({ table: 'users', id: 1 })).toBe(true);
    expect(m.delete({ id: 1, table: 'users' })).toBe(ValueMap.empty());
    expect(m.has({ table: 'users', id: 2 })).toBe(false);
  });

  it('set has/delete accept structural equals; add of an equal is `this`', () => {
    const s = ValueSet.from([{ tag: 'a' }]);
    expect(s.has({ tag: 'a' })).toBe(true);
    expect(s.add({ tag: 'a' })).toBe(s);
    expect(s.delete({ tag: 'a' })).toBe(ValueSet.empty());
  });

  it('unchanged structural writes return `this`', () => {
    const m = ValueMap.empty<string, object>().set('k', { v: 1 });
    expect(m.set('k', { v: 1 })).toBe(m);
    const l = ValueList.of({ v: 1 });
    expect(l.set(0, { v: 1 })).toBe(l);
  });
});

describe('toArray() — the interned flat and cross-representation unity', () => {
  it('toArray()[i] === get(i), always', () => {
    const l = ValueList.of<unknown>({ a: 1 }, 2, 'three');
    const snap = l.toArray();
    for (let i = 0; i < l.length; i++) expect(snap[i]).toBe(l.get(i));
  });

  it('toArray() === intern of the equal plain array', () => {
    const l = ValueList.of<unknown>({ a: 1 }, 2);
    expect(l.toArray()).toBe(intern([{ a: 1 }, 2]));
    expect(Object.isFrozen(l.toArray())).toBe(true);
    expect(l.toArray()).toBe(l.toArray()); // memoized
  });
});
