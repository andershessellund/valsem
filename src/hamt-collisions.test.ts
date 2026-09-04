// Collision-path stress for the hash-consed trie.
//
// A degenerate hasher (every leaf hashes to 0) is installed BEFORE the
// collections load, so every key collides on all 32 bits: each operation
// walks the full 7-level prefix chain into one collision node. This
// deterministically exercises the paths a seeded hasher essentially never
// takes — chain construction, collision-node canonical ordering (mixed
// primitive types and object ordinals), in-collision updates, and full chain
// unwinding on delete.
//
// This file relies on vitest's per-file process isolation: configureHasher
// is once-per-process, and here it must run before any hashing.
import { describe, it, expect } from 'vitest';
import { configureHasher } from './hasher.js';

configureHasher({ string: () => 0, number: () => 0 });

const { ValueMap } = await import('./value-map.js');
const { ValueSet } = await import('./value-set.js');
const { intern } = await import('./intern.js');

describe('total-collision trie (degenerate hasher)', () => {
  it('map operations stay correct when every key collides', () => {
    let m = ValueMap.empty<string | number, number>();
    for (let i = 0; i < 40; i++) m = m.set(`k${i}`, i).set(i, i * 10);
    expect(m.size).toBe(80);
    for (let i = 0; i < 40; i++) {
      expect(m.get(`k${i}`)).toBe(i);
      expect(m.get(i)).toBe(i * 10);
    }
    expect(m.has('missing')).toBe(false);
    expect(m.get('missing')).toBeUndefined();
  });

  it('canonicality holds inside collision nodes (shuffled builds converge)', () => {
    const entries: [string | number, number][] = [];
    for (let i = 0; i < 30; i++) entries.push([i % 2 ? `s${i}` : i, i]);
    const a = ValueMap.from(entries);
    const b = ValueMap.from(entries.slice().reverse());
    expect(b).toBe(a);
    expect([...b.keys()]).toEqual([...a.keys()]);
  });

  it('object members order deterministically via per-instance ordinals', () => {
    const k1 = intern({ a: 1 });
    const k2 = intern({ b: 2 });
    const k3 = intern({ c: 3 });
    const a = ValueSet.from([k1, k2, k3]);
    const b = ValueSet.from([k3, k1, k2]);
    expect(b).toBe(a);
  });

  it('updates inside a collision node hit canonically', () => {
    const base = ValueMap.from<string, number>([
      ['x', 1],
      ['y', 2],
    ]);
    expect(base.set('x', 1)).toBe(base); // unchanged
    expect(base.set('x', 9).set('x', 1)).toBe(base); // detour
  });

  it('deleting down to one entry unwinds the whole chain', () => {
    const single = ValueMap.empty<string, number>().set('only', 1);
    const viaDetour = ValueMap.empty<string, number>()
      .set('only', 1)
      .set('other', 2)
      .delete('other');
    expect(viaDetour).toBe(single);

    const emptyAgain = single.delete('only');
    expect(emptyAgain).toBe(ValueMap.empty());
  });

  it('stored undefined stays distinct from absence under total collision', () => {
    const m = ValueMap.empty<string, number | undefined>().set('a', undefined).set('b', 1);
    expect(m.has('a')).toBe(true);
    expect(m.get('a')).toBeUndefined();
    expect(m.has('zzz')).toBe(false);
  });

  it('sets behave and converge under total collision', () => {
    const members = ['a', 'b', 'c', 1, 2, 3];
    const a = ValueSet.from(members);
    const b = ValueSet.from(members.slice().reverse());
    expect(b).toBe(a);
    expect(a.size).toBe(6);
    for (const x of members) expect(a.has(x)).toBe(true);
    expect(a.delete('a').add('a')).toBe(a);
    let drained = a;
    for (const x of members) drained = drained.delete(x);
    expect(drained).toBe(ValueSet.empty());
  });
});
