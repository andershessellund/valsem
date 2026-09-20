import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ValueList } from './value-list.js';
import { DraftList } from './draft-list.js';
import { produce, produceWithPatches, isDraft } from './produce.js';
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
      d.at(7)!.v = 99; // child draft through a read
      expect(d.length).toBe(3000);
      expect(d.at(5)!.id).toBe(-5);
    });
    const expected = arrOf(3000);
    expected[5] = { id: -5, v: 0 };
    expected.push({ id: 3000, v: 0 });
    expected.splice(100, 2, { id: -100, v: 1 });
    expected[7] = { id: 7, v: 99 };
    expect(next).toBe(ValueList.from(expected));
    expect(produce(base, () => {})).toBe(base);
    expect(produce(base, (d) => void d.set(5, base.at(5)!))).toBe(base);
    expect(produce(base, (d) => void (d.at(7)!.v = 2))).toBe(base); // netted out
    expect(produce(base, (d) => { d.push({ id: 1, v: 1 }); d.pop(); })).toBe(base);
  });

  it('nests inside records, and holds child drafts that survive later splices', () => {
    const state = intern({ list: ValueList.from(arrOf(500)), n: 1 });
    const next = produce(state, (d) => {
      const item = d.list.at(10)!;
      item.v = 42;
      d.list.splice(0, 3); // shifts the drafted item to index 7
      d.list.splice(1, 0, { id: -1, v: 0 }); // and back to 8
      expect(d.list.at(8)).toBe(item);
      d.n = 2;
    });
    const expected = arrOf(500);
    expected[10] = { id: 10, v: 42 };
    expected.splice(0, 3);
    expected.splice(1, 0, { id: -1, v: 0 });
    expect(next.list).toBe(ValueList.from(expected));
    expect(next.list.at(8)).toBe(intern({ id: 10, v: 42 }));
    expect(next.n).toBe(2);
  });

  it('patches record the intent and round-trip both ways; current() and original() work', () => {
    const base = ValueList.from(arrOf(1000));
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      d.set(3, { id: -3, v: 0 });
      d.splice(500, 10, { id: -500, v: 0 });
      d.at(0)!.v = 7;
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
