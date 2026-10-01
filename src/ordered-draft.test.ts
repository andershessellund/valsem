// ---------------------------------------------------------------------------
// DraftOrderedMap / DraftOrderedSet — the ordered collections inside produce:
// order-preserving edits, nested drafts, patches that replay operations in
// order (a netted membership delta would lose the order), inverses,
// current()/original(), applyPatches convergence, and the draft types.
// ---------------------------------------------------------------------------
import { describe, it, expect, expectTypeOf } from 'vitest';
import { produce, produceWithPatches, applyPatches, isDraft, type Draft } from './produce.js';
import { current, original } from './current.js';
import { intern } from './intern.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { DraftOrderedMap } from './draft-ordered-map.js';
import { DraftOrderedSet } from './draft-ordered-set.js';
import { ValueList } from './value-list.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

type Row = { n: number };
const base = () =>
  OrderedMap.from<string, Row>([
    ['a', { n: 1 }],
    ['b', { n: 2 }],
    ['c', { n: 3 }],
  ]);

describe('DraftOrderedMap', () => {
  it('drafts as DraftOrderedMap, with get() returning nested drafts', () => {
    produce(base(), (d) => {
      expectTypeOf(d).toEqualTypeOf<DraftOrderedMap<string, Row>>();
      expect(d).toBeInstanceOf(DraftOrderedMap);
      expect(isDraft(d)).toBe(true);
      const row = d.get('a')!;
      expectTypeOf(row).toEqualTypeOf<Draft<Row>>();
      expect(isDraft(row)).toBe(true);
      expect(d.size).toBe(3);
      expect(d.has('b')).toBe(true);
      expect(d.indexOf('c')).toBe(2);
      expect(d.at(1)![0]).toBe('b');
      expect(d.first()![0]).toBe('a');
      expect(d.last()![0]).toBe('c');
      expect(d.at(1)![1].n).toBe(2);
    });
  });

  it('nested edits keep position; set on a present key keeps position; new keys append', () => {
    const next = produce(base(), (d) => {
      d.get('a')!.n = 10;
      d.set('b', { n: 20 });
      d.set('d', { n: 4 });
    });
    expect([...next].map(([k, v]) => [k, v.n])).toEqual([
      ['a', 10],
      ['b', 20],
      ['c', 3],
      ['d', 4],
    ]);
    expect(next).toBe(
      OrderedMap.from([
        ['a', { n: 10 }],
        ['b', { n: 20 }],
        ['c', { n: 3 }],
        ['d', { n: 4 }],
      ]),
    );
  });

  it('delete then set moves the key to the end; insertAt places it; clear empties', () => {
    const next = produce(base(), (d) => {
      d.delete('a');
      d.set('a', { n: 1 });
      d.insertAt(1, 'z', { n: 0 });
      expect(d.indexOf('a')).toBe(3);
      expect([...d.keys()]).toEqual(['b', 'z', 'c', 'a']);
    });
    expect([...next.keys()]).toEqual(['b', 'z', 'c', 'a']);
    expect(next.get('a')).toBe(intern({ n: 1 }));
    const cleared = produce(base(), (d) => {
      d.clear();
      expect(d.size).toBe(0);
      expect([...d]).toEqual([]);
      d.set('q', { n: 9 });
    });
    expect(cleared).toBe(OrderedMap.from([['q', { n: 9 }]]));
    expect(produce(OrderedMap.empty(), (d) => d.clear())).toBe(OrderedMap.empty());
  });

  it('iteration reflects edits, deletions and child drafts; forEach passes the draft', () => {
    produce(base(), (d) => {
      d.get('a')!.n = 10;
      d.delete('b');
      d.set('d', { n: 4 });
      expect([...d].map(([k, v]) => [k, v.n])).toEqual([
        ['a', 10],
        ['c', 3],
        ['d', 4],
      ]);
      expect([...d.values()].map((v) => v.n)).toEqual([10, 3, 4]);
      const seen: string[] = [];
      d.forEach((v, k, m) => {
        expect(m).toBe(d);
        seen.push(k);
      });
      expect(seen).toEqual(['a', 'c', 'd']);
    });
  });

  it('a no-op recipe, or edits that net out, return the base and emit no patches', () => {
    const b = base();
    expect(produce(b, () => {})).toBe(b);
    const [same, patches, inverse] = produceWithPatches(b, (d) => {
      d.set('a', { n: 1 });
      d.set('x', { n: 0 });
      d.delete('x');
      d.get('b')!.n = 2;
    });
    expect(same).toBe(b);
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });

  it('delete then set with the same value does NOT net out: the order changed, and the patches say so', () => {
    const b = base();
    const [moved, patches, inverse] = produceWithPatches(b, (d) => {
      d.delete('a');
      d.set('a', { n: 1 });
    });
    expect([...moved.keys()]).toEqual(['b', 'c', 'a']);
    expect(patches.map((p) => p.kind)).toEqual(['omap.delete', 'omap.set']);
    expect(inverse.map((p) => p.kind)).toEqual(['omap.delete', 'omap.insert']);
    expectPatchRoundTrip(b, moved, patches, inverse);
  });

  it('patches replay the operations in order, nested edits patch under the key, and both directions converge', () => {
    const b = base();
    const [next, patches, inverse] = produceWithPatches(b, (d) => {
      d.get('a')!.n = 10;
      d.delete('b');
      d.set('b', { n: 22 });
      d.set('d', { n: 4 });
      d.insertAt(0, 'z', { n: 0 });
    });
    expect([...next.keys()]).toEqual(['z', 'a', 'c', 'b', 'd']);
    expect(patches).toEqual([
      { kind: 'omap.delete', path: [], key: 'b' },
      { kind: 'omap.set', path: [], key: 'b', value: intern({ n: 22 }) },
      { kind: 'omap.set', path: [], key: 'd', value: intern({ n: 4 }) },
      { kind: 'omap.insert', path: [], index: 0, key: 'z', value: intern({ n: 0 }) },
      { kind: 'record.set', path: ['a'], key: 'n', value: 10 },
    ]);
    expectPatchRoundTrip(b, next, patches, inverse);
  });

  it('clear emits a delete per key and inverts to sets in the original order', () => {
    const b = base();
    const [cleared, patches, inverse] = produceWithPatches(b, (d) => {
      d.clear();
      d.set('q', { n: 9 });
    });
    expect(patches.map((p) => p.kind)).toEqual(['omap.delete', 'omap.delete', 'omap.delete', 'omap.set']);
    expectPatchRoundTrip(b, cleared, patches, inverse);
  });

  it('current() is the canonical map as it stands; original() is the base; the draft stays live', () => {
    const b = base();
    const next = produce(b, (d) => {
      d.get('a')!.n = 10;
      d.delete('c');
      const snap = current(d);
      expect(snap).toBeInstanceOf(OrderedMap);
      expect(snap).toBe(
        OrderedMap.from([
          ['a', { n: 10 }],
          ['b', { n: 2 }],
        ]),
      );
      expect(original(d)).toBe(b);
      d.set('e', { n: 5 });
    });
    expect([...next.keys()]).toEqual(['a', 'b', 'e']);
  });

  it('works as a field of a record, with paths through the record and the map', () => {
    const state = intern({ rows: base(), tags: OrderedSet.of('x', 'y') });
    const [next, patches, inverse] = produceWithPatches(state, (d) => {
      expectTypeOf(d.rows).toEqualTypeOf<DraftOrderedMap<string, Row>>();
      expectTypeOf(d.tags).toEqualTypeOf<DraftOrderedSet<string>>();
      d.rows.get('c')!.n = 30;
      d.rows.delete('a');
      d.tags.delete('x');
      d.tags.add('x');
    });
    expect([...next.rows.keys()]).toEqual(['b', 'c']);
    expect(next.rows.get('c')).toBe(intern({ n: 30 }));
    expect([...next.tags]).toEqual(['y', 'x']);
    expect(patches.map((p) => `${p.path.join('/')}:${p.kind}`)).toEqual([
      'rows:omap.delete',
      'rows/c:record.set',
      'tags:oset.delete',
      'tags:oset.add',
    ]);
    expectPatchRoundTrip(state, next, patches, inverse);
  });

  it('a canonical value assigned into the draft is copied on write when read back', () => {
    const b = base();
    const shared = intern({ n: 7 });
    const next = produce(b, (d) => {
      d.set('s', shared);
      d.get('s')!.n = 8;
    });
    expect(shared.n).toBe(7);
    expect(next.get('s')).toBe(intern({ n: 8 }));
  });

  it('an escaped draft throws; a draft from another produce() cannot be assigned', () => {
    let escaped: DraftOrderedMap<string, Row> | undefined;
    produce(base(), (d) => {
      escaped = d;
    });
    expect(() => escaped!.size).toThrow(/escaped/);
    expect(() => escaped!.set('x', { n: 0 })).toThrow(/escaped/);
    produce(base(), (outer) => {
      const stolen = outer.get('a')!;
      expect(() => produce(base(), (inner) => void inner.set('x', stolen))).toThrow(/different produce/);
      expect(() => produce(base(), (inner) => void inner.insertAt(0, 'x', stolen))).toThrow(/different produce/);
    });
  });

  it('rejects a bad insert or a malformed patch', () => {
    expect(() => produce(base(), (d) => void d.insertAt(9, 'z', { n: 0 }))).toThrow(RangeError);
    expect(() => produce(base(), (d) => void d.insertAt(0, 'a', { n: 0 }))).toThrow(/already present/);
    expect(() => applyPatches(base(), [{ kind: 'omap.insert', path: [], index: 1.5, key: 'z', value: 1 }])).toThrow(/integer index/);
    expect(() => applyPatches(base(), [{ kind: 'set.add', path: [], value: 1 }])).toThrow(/cannot apply/);
  });
});

describe('DraftOrderedSet', () => {
  it('drafts as DraftOrderedSet: add appends, delete removes, insertAt places, clear empties', () => {
    const b = OrderedSet.of('a', 'b', 'c');
    const next = produce(b, (d) => {
      expectTypeOf(d).toEqualTypeOf<DraftOrderedSet<string>>();
      expect(d).toBeInstanceOf(DraftOrderedSet);
      d.add('a'); // present: stays
      d.delete('b');
      d.add('b'); // re-added: moves to the end
      d.insertAt(0, 'z');
      expect(d.size).toBe(4);
      expect([...d]).toEqual(['z', 'a', 'c', 'b']);
      expect(d.indexOf('b')).toBe(3);
      expect(d.first()).toBe('z');
      expect(d.last()).toBe('b');
      expect(d.at(1)).toBe('a');
      expect(d.has('z')).toBe(true);
      expect([...d.entries()]).toEqual([
        ['z', 'z'],
        ['a', 'a'],
        ['c', 'c'],
        ['b', 'b'],
      ]);
      const seen: string[] = [];
      d.forEach((v, v2, s) => {
        expect(v2).toBe(v);
        expect(s).toBe(d);
        seen.push(v);
      });
      expect(seen).toEqual(['z', 'a', 'c', 'b']);
    });
    expect(next).toBe(OrderedSet.of('z', 'a', 'c', 'b'));
    expect(produce(b, (d) => void d.clear())).toBe(OrderedSet.empty());
    expect(produce(b, () => {})).toBe(b);
  });

  it('patches replay in order, invert, and converge; netted edits emit none', () => {
    const b = OrderedSet.of('a', 'b', 'c');
    const [next, patches, inverse] = produceWithPatches(b, (d) => {
      d.delete('a');
      d.add('a');
      d.insertAt(1, 'z');
      d.delete('c');
    });
    expect([...next]).toEqual(['b', 'z', 'a']);
    expect(patches).toEqual([
      { kind: 'oset.delete', path: [], value: 'a' },
      { kind: 'oset.add', path: [], value: 'a' },
      { kind: 'oset.insert', path: [], index: 1, value: 'z' },
      { kind: 'oset.delete', path: [], value: 'c' },
    ]);
    expectPatchRoundTrip(b, next, patches, inverse);
    const [same, none] = produceWithPatches(b, (d) => {
      d.add('x');
      d.delete('x');
    });
    expect(same).toBe(b);
    expect(none).toEqual([]);
    const [cleared, cp, ci] = produceWithPatches(b, (d) => void d.clear());
    expect(cleared).toBe(OrderedSet.empty());
    expect(cp.map((p) => p.kind)).toEqual(['oset.delete', 'oset.delete', 'oset.delete']);
    expect(applyPatches(cleared, ci)).toBe(b);
  });

  it('current() and original()', () => {
    const b = OrderedSet.of(1, 2);
    produce(b, (d) => {
      d.add(3);
      expect(current(d)).toBe(OrderedSet.of(1, 2, 3));
      expect(original(d)).toBe(b);
      d.delete(1);
      expect(current(d)).toBe(OrderedSet.of(2, 3));
    });
  });

  it('members are interned on entry, so a raw record is found by content and the result is canonical', () => {
    const next = produce(OrderedSet.empty<{ x: number }>(), (d) => {
      d.add({ x: 1 });
      expect(d.has({ x: 1 })).toBe(true);
      expect(d.add({ x: 1 }).size).toBe(1);
    });
    expect(next).toBe(OrderedSet.from([{ x: 1 }]));
    expect(next.valueList).toBe(ValueList.of({ x: 1 }));
  });
});

describe("the ordered drafts' walks, positions and iterators", () => {
  it('an entry deleted before the walk reaches it is not visited (DraftOrderedMap, DraftOrderedSet)', () => {
    const visited: string[] = [];
    const next = produce(base(), (d) => {
      for (const [k, v] of d) {
        visited.push(k);
        if (k === 'a') { d.delete('b'); d.delete('c'); }
        v.n = v.n * 10; // never `undefined`: a deleted entry is not offered
      }
    });
    expect(visited).toEqual(['a']);
    expect(next).toBe(OrderedMap.from([['a', { n: 10 }]]));
    const seen: string[] = [];
    produce(OrderedSet.of('a', 'b', 'c'), (d) => { for (const v of d) { seen.push(v); if (v === 'a') { d.delete('b'); d.delete('c'); } } });
    expect(seen).toEqual(['a']);
  });

  it("a bad position is reported in the draft's own name", () => {
    produce(intern({ os: OrderedSet.of('a'), om: base() }), (d) => {
      expect(() => d.os.at(NaN)).toThrow(/DraftOrderedSet\.at/);
      expect(() => d.om.at(1.5)).toThrow(/DraftOrderedMap\.at/);
    });
    expect(() => OrderedSet.of('a').at(NaN)).toThrow(/OrderedSet\.at/);
  });

  it('an iterator that outlives its recipe throws on its next step', () => {
    let it!: Iterator<string>;
    produce(OrderedSet.of('a', 'b'), (d) => { it = d.values(); it.next(); });
    expect(() => it.next()).toThrow(/escaped its produce\(\) call/);
    let keys!: Iterator<string>;
    produce(base(), (d) => { keys = d.keys(); });
    expect(() => keys.next()).toThrow(/escaped/);
  });

  it('an ordered set reduce without an initial value folds from the first member, in order', () => {
    expect(OrderedSet.of('a', 'b', 'c').reduce((acc, v) => acc + v)).toBe('abc');
    expect(() => OrderedSet.empty<string>().reduce((acc, v) => acc + v)).toThrow(TypeError);
    produce(OrderedSet.of('a', 'b'), (d) => { expect(d.reduce((acc, v) => acc + v)).toBe('ab'); });
  });
});

describe('the ordered drafts walk as a native Map or Set does (D65)', () => {
  it('an entry appended during the walk is visited; one deleted before its turn is not; one deleted and re-added is visited again, at its new place', () => {
    const visited: string[] = [];
    const next = produce(OrderedMap.from<string, number>([['a', 1], ['b', 2], ['c', 3]]), (d) => {
      for (const [k] of d) {
        visited.push(k);
        if (k === 'a') { d.set('z', 26); d.delete('b'); }
        if (k === 'c') { d.delete('a'); d.set('a', 10); } // re-added: moves to the end
        if (visited.length > 10) throw new Error('runaway');
      }
    });
    expect(visited).toEqual(['a', 'c', 'z', 'a']);
    expect([...next.keys()]).toEqual(['c', 'z', 'a']);
    const seen: string[] = [];
    produce(OrderedSet.of('a', 'b', 'c'), (d) => {
      for (const v of d) {
        seen.push(v);
        if (v === 'a') { d.add('z'); d.delete('b'); }
        if (v === 'c') { d.delete('a'); d.add('a'); }
        if (seen.length > 10) throw new Error('runaway');
      }
    });
    expect(seen).toEqual(['a', 'c', 'z', 'a']);
  });

  it('an insert before the walk\'s position does not shift what it visits next; one at or after it is visited in order', () => {
    const visited: string[] = [];
    produce(OrderedMap.from<string, number>([['a', 1], ['b', 2], ['c', 3]]), (d) => {
      for (const [k] of d) {
        visited.push(k);
        if (k === 'b') { d.insertAt(0, 'first', 0); d.insertAt(d.size, 'last', 9); d.insertAt(d.indexOf('c'), 'before-c', 5); }
      }
    });
    expect(visited).toEqual(['a', 'b', 'before-c', 'c', 'last']);
    const seen: string[] = [];
    produce(OrderedSet.of('a', 'b', 'c'), (d) => {
      for (const v of d) {
        seen.push(v);
        if (v === 'b') { d.insertAt(0, 'first'); d.insertAt(d.indexOf('c'), 'before-c'); }
      }
    });
    expect(seen).toEqual(['a', 'b', 'before-c', 'c']);
  });

  it('clear() during the walk ends it, and what is set after the clear is visited', () => {
    const visited: string[] = [];
    const next = produce(OrderedMap.from<string, number>([['a', 1], ['b', 2]]), (d) => {
      for (const [k] of d) {
        visited.push(k);
        if (k === 'a') { d.clear(); d.set('z', 26); }
      }
    });
    expect(visited).toEqual(['a', 'z']);
    expect(next).toBe(OrderedMap.from([['z', 26]]));
    const seen: string[] = [];
    produce(OrderedSet.of('a', 'b'), (d) => { for (const v of d) { seen.push(v); if (v === 'a') { d.clear(); d.add('z'); } } });
    expect(seen).toEqual(['a', 'z']);
  });

  it('a walk that only sets present keys is the iterator it began with: nothing re-read by position', () => {
    const visited: string[] = [];
    const next = produce(base(), (d) => { for (const [k, v] of d) { visited.push(k); v.n *= 10; } });
    expect(visited).toEqual(['a', 'b', 'c']);
    expect(next).toBe(OrderedMap.from([['a', { n: 10 }], ['b', { n: 20 }], ['c', { n: 30 }]]));
  });
});
