// ---------------------------------------------------------------------------
// console.log sees the collections.
//
// A class with `#private` state prints as `ValueList {}`: a state tree in a
// log line, a failing test's diff or a debugger hover showed every collection
// as empty. Each collection answers Node's `util.inspect` hook with its
// name, size and contents, in the form Node gives the native collections,
// and carries a `Symbol.toStringTag`, the name a minifier cannot take.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { intern } from './intern.js';
import { produce } from './produce.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { HashMap } from './hash-map.js';
import { HashSet } from './hash-set.js';

describe('util.inspect', () => {
  it('prints name, size and contents, as Node prints a native collection', () => {
    expect(inspect(ValueList.of<unknown>(1, 'a', { k: [true] }))).toBe("ValueList(3) [ 1, 'a', { k: [ true ] } ]");
    expect(inspect(OrderedSet.from(['b', 'a']))).toBe("OrderedSet(2) { 'b', 'a' }");
    expect(inspect(OrderedMap.from([['b', 1], [{ id: 2 }, 'two']] as [unknown, unknown][]))).toBe("OrderedMap(2) { 'b' => 1, { id: 2 } => 'two' }");
    expect(inspect(ValueSet.from(['x']))).toBe("ValueSet(1) { 'x' }");
    expect(inspect(ValueMap.from([['k', { v: 1 }]]))).toBe("ValueMap(1) { 'k' => { v: 1 } }");
    expect(inspect(HashSet.from([1, 2]))).toBe('HashSet(2) { 1, 2 }');
    expect(inspect(HashMap.from([[{ a: 1 }, 'x']]))).toBe("HashMap(1) { { a: 1 } => 'x' }");
    expect(inspect(ValueList.empty())).toBe('ValueList(0) []');
    expect(inspect(ValueMap.empty())).toBe('ValueMap(0) {}');
  });

  it('inside a state tree, with Node’s depth rule and options', () => {
    const state = intern({ todos: ValueList.of({ id: 1 }), tags: ValueSet.from(['x']) });
    expect(inspect(state)).toBe("{ todos: ValueList(1) [ { id: 1 } ], tags: ValueSet(1) { 'x' } }");
    const deep = ValueList.of(ValueList.of(ValueList.of(ValueList.of(1))));
    expect(inspect(deep)).toBe('ValueList(1) [ ValueList(1) [ ValueList(1) [ [ValueList] ] ] ]');
    expect(inspect(deep, { depth: 0 })).toBe('ValueList(1) [ [ValueList] ]');
    expect(inspect(deep, { depth: null })).toBe('ValueList(1) [ ValueList(1) [ ValueList(1) [ ValueList(1) [ 1 ] ] ] ]');
    expect(inspect(ValueList.from(Array.from({ length: 150 }, (_, i) => i)))).toContain('... 50 more items');
  });

  it('a draft prints what it holds right now; a revoked one says so instead of throwing', () => {
    const base = intern({
      l: ValueList.of({ n: 1 }),
      m: ValueMap.from([['k', 1]]),
      s: ValueSet.from(['a']),
      om: OrderedMap.from([['x', 1]]),
      os: OrderedSet.from(['p']),
    });
    let leaked: unknown;
    produce(base, (d) => {
      d.l.get(0).n = 10;
      d.l.push({ n: 2 });
      d.m.set('k', 2);
      d.s.delete('a');
      d.om.set('y', 2);
      d.os.insertAt(0, 'o');
      expect(inspect(d.l)).toBe('DraftList(2) [ { n: 10 }, { n: 2 } ]');
      expect(inspect(d.m)).toBe("DraftMap(1) { 'k' => 2 }");
      expect(inspect(d.s)).toBe('DraftSet(0) {}');
      expect(inspect(d.om)).toBe("DraftOrderedMap(2) { 'x' => 1, 'y' => 2 }");
      expect(inspect(d.os)).toBe("DraftOrderedSet(2) { 'o', 'p' }");
      leaked = d.l;
    });
    expect(inspect(leaked)).toBe('[revoked DraftList]');
  });
});

describe('Symbol.toStringTag', () => {
  it.each([
    ['ValueList', ValueList.empty()],
    ['ValueMap', ValueMap.empty()],
    ['ValueSet', ValueSet.empty()],
    ['OrderedMap', OrderedMap.empty()],
    ['OrderedSet', OrderedSet.empty()],
    ['HashMap', new HashMap()],
    ['HashSet', new HashSet()],
  ])('%s', (name, value) => {
    expect(Object.prototype.toString.call(value)).toBe(`[object ${name}]`);
    expect(Object.keys(value)).toEqual([]); // a prototype getter: no own property, nothing for a spread to copy
  });
});

describe('a draft that outlived its recipe', () => {
  it('inspects as revoked instead of throwing from inside console.log', () => {
    // Node answers for a revoked Proxy itself (`<Revoked Proxy>`), before any
    // hook; the draft's own hook says the same where a runtime does ask it.
    let leakedRecord: unknown;
    let leakedArray: unknown;
    produce(intern({ list: [1, 2] }), (d) => {
      leakedRecord = d;
      leakedArray = d.list;
    });
    expect(inspect(leakedRecord)).toMatch(/revoked/i);
    expect(inspect(leakedArray)).toMatch(/revoked/i);
    expect(inspect({ holding: leakedRecord })).toMatch(/revoked/i);
  });
});
