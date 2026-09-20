// Collision-path stress for the hash-consed trie.
//
// A degenerate hasher (every string hashes to 0, and every number) is
// installed BEFORE the collections load, so every key collides on all 32
// bits with every other key OF ITS KIND: each operation walks the full
// 7-level prefix chain into one collision node. This deterministically
// exercises the paths a seeded hasher essentially never takes — chain
// construction, collision-node canonical ordering within a kind (numbers,
// bigints, strings, symbols, object ordinals), in-collision updates, and
// full chain unwinding on delete.
//
// Kinds stay apart here: a leaf's hash is mixed with its kind's tag, so a
// constant hasher gives strings one hash and numbers another. Nodes holding
// SEVERAL kinds, and the ordered collections, the intern pool and memoize
// under collision, are collisions.test.ts.
//
// This file relies on vitest's per-file process isolation: configureHasher
// is once-per-process, and here it must run before any hashing.
import { describe, it, expect } from 'vitest';
import { configureHasher } from './hasher.js';
import { shuffled } from './rng.test-helpers.js';

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

  it('canonical member order within every kind (mixed members converge)', () => {
    // memberCompare orders collision-node members by kind, then within the
    // kind; every within-kind branch decides canonical form, so each must
    // converge. Each kind has its own node here (see the header): numbers in
    // one, strings in another, bigints, records. undefined, null and the
    // booleans have fixed hashes and sit in no collision node at all; they
    // are here as ordinary neighbours. Across kinds: collisions.test.ts.
    const members: unknown[] = [
      undefined, null, true, false,
      3, -1, 0, NaN, Infinity, -Infinity, 2.5,
      10n, -2n, 0n,
      'b', 'a', '', 'ab',
      intern({ k: 1 }), intern({ k: 2 }), intern([1]),
    ];
    const canonical = ValueSet.from(members);
    expect(canonical.size).toBe(members.length);
    for (let s = 1; s <= 12; s++) {
      const built = ValueSet.from(shuffled(members, s));
      expect(built).toBe(canonical);
      let chained = ValueSet.empty<unknown>();
      for (const m of shuffled(members, s + 100)) chained = chained.add(m);
      expect(chained).toBe(canonical);
    }
    for (const m of members) expect(canonical.has(m)).toBe(true);
    expect(canonical.has(-0)).toBe(true); // SameValueZero with the stored 0
    expect(canonical.has('c')).toBe(false);
    expect(canonical.has(11n)).toBe(false);
  });

  it('maps with mixed-rank colliding keys converge and read back', () => {
    const entries: [unknown, number][] = [
      [null, 1], [undefined, 2], [true, 3], [NaN, 4], [7, 5], [5n, 6], ['x', 7], [intern({ q: 1 }), 8],
    ];
    const a = ValueMap.from(entries);
    const b = ValueMap.from(entries.slice().reverse());
    expect(b).toBe(a);
    for (const [k, v] of entries) expect(a.get(k)).toBe(v);
    expect(a.get('nope')).toBeUndefined();
    expect(a.delete('nope')).toBe(a); // collision-node miss on remove
    let drained = a;
    for (const [k] of entries) drained = drained.delete(k);
    expect(drained).toBe(ValueMap.empty());
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

describe('total-collision trie — node-level set algebra through collision nodes', () => {
  // Member kind keyed on the VALUE, so `members(20)` and `members(20, 10)` overlap on 10..19.
  const members = (n: number, from = 0): (string | number | object)[] =>
    Array.from({ length: n }, (_, i) => {
      const v = i + from;
      return v % 3 === 0 ? `s${v}` : v % 3 === 1 ? v : intern({ o: v });
    });

  it('every operation converges on ValueSet.from of the array answer', () => {
    const xs = members(20);
    const ys = members(20, 10); // overlaps xs on 10..19
    const A = ValueSet.from(xs);
    const B = ValueSet.from(ys);
    const inA = (v: unknown): boolean => A.has(v as never);
    const inB = (v: unknown): boolean => B.has(v as never);
    expect(A.union(B)).toBe(ValueSet.from([...xs, ...ys]));
    expect(A.intersection(B)).toBe(ValueSet.from(xs.filter(inB)));
    expect(A.difference(B)).toBe(ValueSet.from(xs.filter((v) => !inB(v))));
    expect(A.symmetricDifference(B)).toBe(
      ValueSet.from([...xs.filter((v) => !inB(v)), ...ys.filter((v) => !inA(v))]),
    );
    expect(A.isSubsetOf(B)).toBe(false);
    expect(A.intersection(B).isSubsetOf(B)).toBe(true);
    expect(A.isDisjointFrom(B)).toBe(false);
    expect(A.difference(B).isDisjointFrom(B)).toBe(true);
    expect(A.union(B).size).toBe(30);
    expect(A.intersection(B).size).toBe(10);
    expect(A.union(A)).toBe(A);
    expect(A.difference(A)).toBe(ValueSet.empty());
  });

  it('collapse to one member and to empty keep canonical form', () => {
    const A = ValueSet.from(members(6));
    const one = ValueSet.from([members(6)[2]]);
    expect(A.intersection(one)).toBe(one);
    expect(A.difference(A.difference(one))).toBe(one);
    expect(one.difference(A)).toBe(ValueSet.empty());
    expect(A.symmetricDifference(A.difference(one))).toBe(one);
  });
});

describe('symbols inside a collision node', () => {
  // Collision order put symbols in the OBJECT rank, ordered by a WeakMap of
  // ordinals. A registered symbol (`Symbol.for`) is not a valid weak key, so
  // two of them in one collision node threw "Invalid value used as weak map
  // key" from ValueSet.from. Under this file's hasher every registered symbol
  // hashes alike (their hash is their name's), so the node is certain.
  const registered = ['delta', 'alpha', 'charlie', 'bravo'].map((n) => Symbol.for(`valsem.test.${n}`));
  const unique = [Symbol('u1'), Symbol('u2'), Symbol('u3')];

  it('registered symbols are members, and shuffled builds converge', () => {
    const a = ValueSet.from(registered);
    expect(a.size).toBe(4);
    for (const s of registered) expect(a.has(s)).toBe(true);
    expect(a.has(Symbol.for('valsem.test.other'))).toBe(false);
    expect(ValueSet.from(registered.slice().reverse())).toBe(a);
    expect(ValueSet.from([registered[2]!, registered[0]!, registered[3]!, registered[1]!])).toBe(a);
  });

  it('as map keys, with updates and deletes inside the node', () => {
    let m = ValueMap.empty<symbol, number>();
    registered.forEach((s, i) => (m = m.set(s, i)));
    expect(m.size).toBe(4);
    registered.forEach((s, i) => expect(m.get(s)).toBe(i));
    m = m.set(registered[1]!, 99).delete(registered[0]!);
    expect(m.get(registered[1]!)).toBe(99);
    expect(m.has(registered[0]!)).toBe(false);
    expect(m.size).toBe(3);
  });

  it('registered, unique and well-known symbols mix with every other kind', () => {
    const members: unknown[] = [...registered, ...unique, Symbol.iterator, 'str', 1, true, null, undefined, 10n, intern({ o: 1 })];
    const a = ValueSet.from(members);
    expect(a.size).toBe(members.length);
    for (const v of members) expect(a.has(v)).toBe(true);
    expect(ValueSet.from(members.slice().reverse())).toBe(a);
    // Canonical order is a function of the members, not of insertion order.
    expect([...ValueSet.from(members.slice().reverse())]).toEqual([...a]);
    let shrunk = a;
    for (const s of registered) shrunk = shrunk.delete(s);
    expect(shrunk).toBe(ValueSet.from(members.filter((v) => !registered.includes(v as symbol))));
  });
});
