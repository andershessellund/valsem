import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { DraftList } from './draft-list.js';
import { produce, produceWithPatches, applyPatches, isDraft } from './produce.js';
import { current, original } from './current.js';
import { intern } from './intern.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

const arrOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, v: i % 5 }));

describe('ValueList inside produce — the chunked draft', () => {
  it('drafts as DraftList; edits land on the canonical list; no-ops return the base', () => {
    const base = ValueList.from(arrOf(3000));
    const next = produce(base, (d) => {
      expect(d).toBeInstanceOf(DraftList);
      expect(isDraft(d)).toBe(true);
      d.set(5, { id: -5, v: 0 });
      d.push({ id: 3000, v: 0 });
      d.splice(100, 2, { id: -100, v: 1 });
      d.get(7)!.v = 99; // child draft through a read
      expect(d.length).toBe(3000);
      expect(d.get(5)!.id).toBe(-5);
    });
    const expected = arrOf(3000);
    expected[5] = { id: -5, v: 0 };
    expected.push({ id: 3000, v: 0 });
    expected.splice(100, 2, { id: -100, v: 1 });
    expected[7] = { id: 7, v: 99 };
    expect(next).toBe(ValueList.from(expected));
    expect(produce(base, () => {})).toBe(base);
    expect(produce(base, (d) => void d.set(5, base.get(5)!))).toBe(base);
    expect(produce(base, (d) => void (d.get(7)!.v = 2))).toBe(base); // netted out
    expect(produce(base, (d) => { d.push({ id: 1, v: 1 }); d.pop(); })).toBe(base);
  });

  it('nests inside records, and holds child drafts that survive later splices', () => {
    const state = intern({ list: ValueList.from(arrOf(500)), n: 1 });
    const next = produce(state, (d) => {
      const item = d.list.get(10)!;
      item.v = 42;
      d.list.splice(0, 3); // shifts the drafted item to index 7
      d.list.splice(1, 0, { id: -1, v: 0 }); // and back to 8
      expect(d.list.get(8)).toBe(item);
      d.n = 2;
    });
    const expected = arrOf(500);
    expected[10] = { id: 10, v: 42 };
    expected.splice(0, 3);
    expected.splice(1, 0, { id: -1, v: 0 });
    expect(next.list).toBe(ValueList.from(expected));
    expect(next.list.get(8)).toBe(intern({ id: 10, v: 42 }));
    expect(next.n).toBe(2);
  });

  it('patches record the intent and round-trip both ways; current() and original() work', () => {
    const base = ValueList.from(arrOf(1000));
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      d.set(3, { id: -3, v: 0 });
      d.splice(500, 10, { id: -500, v: 0 });
      d.get(0)!.v = 7;
      expect(current(d)).toBe(ValueList.from((() => { const e = arrOf(1000); e[3] = { id: -3, v: 0 }; e.splice(500, 10, { id: -500, v: 0 }); e[0] = { id: 0, v: 7 }; return e; })()));
      expect(original(d)).toBe(base);
    });
    expect(patches).toEqual([
      { kind: 'list.set', path: [], index: 3, value: intern({ id: -3, v: 0 }) },
      { kind: 'list.splice', path: [], index: 500, remove: 10, insert: [intern({ id: -500, v: 0 })] },
      { kind: 'record.set', path: [0], key: 'v', value: 7 },
    ]);
    expectPatchRoundTrip(base, next, patches, inverse);
  });

  it('property: a recipe of random operations equals the same operations on an array', () => {
    const item = fc.integer({ min: 0, max: 30 });
    const op = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), i: fc.nat(), v: item }),
      fc.record({ kind: fc.constant('push' as const), v: item }),
      fc.record({ kind: fc.constant('pop' as const) }),
      fc.record({ kind: fc.constant('splice' as const), i: fc.nat(), del: fc.nat(4), items: fc.array(item, { maxLength: 4 }) }),
      fc.record({ kind: fc.constant('insert' as const), i: fc.nat(), v: item }),
      fc.record({ kind: fc.constant('remove' as const), i: fc.nat() }),
      fc.record({ kind: fc.constant('shift' as const) }),
      fc.record({ kind: fc.constant('unshift' as const), items: fc.array(item, { maxLength: 3 }) }),
    );
    fc.assert(
      fc.property(fc.array(item, { maxLength: 150 }), fc.array(op, { maxLength: 30 }), (init, ops) => {
        const mirror = init.slice();
        const base = ValueList.from(init);
        const [next, patches, inverse] = produceWithPatches(base, (d) => {
          for (const o of ops) {
            const n = mirror.length;
            switch (o.kind) {
              case 'set': if (n === 0) break; { const i = o.i % n; mirror[i] = o.v; d.set(i, o.v); } break;
              case 'push': mirror.push(o.v); d.push(o.v); break;
              case 'pop': mirror.pop(); d.pop(); break;
              case 'splice': { const i = o.i % (n + 1); mirror.splice(i, o.del, ...o.items); d.splice(i, o.del, ...o.items); } break;
              case 'insert': { const i = o.i % (n + 1); mirror.splice(i, 0, o.v); expect(d.insert(i, o.v)).toBe(d); } break;
              case 'remove': if (n === 0) break; { const i = o.i % n; expect(d.remove(i)).toBe(mirror.splice(i, 1)[0]); } break;
              case 'shift': expect(d.shift()).toBe(mirror.shift()); break;
              case 'unshift': expect(d.unshift(...o.items)).toBe(mirror.unshift(...o.items)); break;
            }
            expect(d.length).toBe(mirror.length);
          }
          expect([...d]).toEqual(mirror);
        });
        expect(next).toBe(ValueList.from(mirror));
        expectPatchRoundTrip(base, next, patches, inverse);
      }),
      { numRuns: 200 },
    );
  });
});

describe('DraftList — what a removal verb hands back, and the list at scale', () => {
  type Todo = { id: number; done: boolean };
  const todos = () => intern({ todos: ValueList.of<Todo>({ id: 1, done: false }, { id: 2, done: false }), done: ValueList.empty<Todo>() });

  it('pop, shift, splice and remove hand out the removed element drafted, as get would', () => {
    const next = produce(todos(), (d) => {
      const t = d.todos.shift()!;
      expect(isDraft(t)).toBe(true);
      t.done = true;
      d.done.push(t);
    });
    expect(next).toBe(intern({ todos: ValueList.of({ id: 2, done: false }), done: ValueList.of({ id: 1, done: true }) }));
    const [r, patches, inverse] = produceWithPatches(todos(), (d) => {
      const t = d.todos.remove(1);
      t.done = true;
      d.done.push(t);
      const u = d.todos.pop()!;
      expect(isDraft(u)).toBe(true);
      d.done.unshift(u);
    });
    expect(r).toBe(intern({ todos: ValueList.empty(), done: ValueList.of({ id: 1, done: false }, { id: 2, done: true }) }));
    expectPatchRoundTrip(todos(), r, patches, inverse);
    produce(todos(), (d) => {
      const fresh = { id: 3, done: false };
      d.todos.push(fresh);
      expect(d.todos.pop()).toBe(fresh); // the recipe's own material comes back raw
      expect(d.todos.splice(0).map(isDraft)).toEqual([true, true]);
    });
  });

  it('an undo of splice(0) on 150,000 elements applies: a patch inserts its elements as the array they are', () => {
    const big = intern({ l: ValueList.from(Array.from({ length: 150_000 }, (_, i) => i)) });
    const [r, patches, inverse] = produceWithPatches(big, (d) => { d.l.splice(0); });
    expect(r.l.length).toBe(0);
    expect(applyPatches(r, inverse)).toBe(big);
    expect(applyPatches(big, patches)).toBe(r);
  });

  it('replaying pushes as tail splices re-indexes no overlay: 20,000 of them in well under a second', () => {
    const base = intern({ l: ValueList.empty<number>() });
    const [next, patches] = produceWithPatches(base, (d) => { for (let i = 0; i < 20_000; i++) d.l.push(i); });
    const t = performance.now();
    expect(applyPatches(base, patches)).toBe(next);
    expect(performance.now() - t).toBeLessThan(2000); // quadratic, this took ~20 s
  });

  it("an empty list's concat takes a ValueList, or a draft standing for its value, and nothing else", () => {
    produce(intern({ a: ValueList.empty<number>(), b: ValueList.of(1) }), (d) => {
      const r = d.a.concat(d.b as unknown as ValueList<number>);
      expect(isDraft(r)).toBe(false);
      expect(r).toBe(ValueList.of(1));
      d.b.push(2);
      expect(d.a.concat(d.b as unknown as ValueList<number>)).toBe(ValueList.of(1, 2)); // the value it is right now
    });
  });
});
