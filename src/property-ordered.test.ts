// ---------------------------------------------------------------------------
// OrderedMap / OrderedSet under random operation sequences, against an array
// model. Three invariants per step: the content and order match the model;
// every key finds its position through the anchors, and the stored anchors
// equal those a from-scratch build derives; and the instance is the
// canonical one — `from(model)` is the same object, so a shape that reached
// the right content by a different route would fail. Then the same
// sequences through produce: the result is canonical, `current()` agrees
// with it, and the patches replay and invert to the same instances.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { ValueList } from './value-list.js';
import { produceWithPatches, applyPatches } from './produce.js';
import { current } from './current.js';

type Op =
  | { t: 'append'; k: number; v: number }
  | { t: 'setExisting'; i: number; v: number }
  | { t: 'delete'; i: number }
  | { t: 'insert'; i: number; k: number; v: number };

/** Keys are small so sequences revisit them (delete then re-add, set on present). */
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('append' as const), k: fc.integer({ min: 0, max: 200 }), v: fc.integer({ min: 0, max: 9 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('setExisting' as const), i: fc.nat(), v: fc.integer({ min: 0, max: 9 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('delete' as const), i: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('insert' as const), i: fc.nat(), k: fc.integer({ min: 0, max: 200 }), v: fc.integer({ min: 0, max: 9 }) }) },
);

/** The anchors a from-scratch build of `keys` assigns — the oracle for the incremental ones. */
function anchorsFromScratch(keys: unknown[]): Map<unknown, unknown> {
  const { result, consed } = ValueList._record(() => ValueList.from(keys));
  return ValueList._anchorUpdates(consed, result);
}

function checkMap(m: OrderedMap<number, number>, model: [number, number][]): void {
  expect([...m]).toEqual(model);
  const expected = anchorsFromScratch(model.map(([k]) => k));
  for (let i = 0; i < model.length; i++) {
    const [k, v] = model[i]!;
    expect(m.indexOf(k)).toBe(i);
    expect(m.get(k)).toBe(v);
    expect(m._anchorOf(k)).toBe(expected.get(k));
  }
  expect(m).toBe(OrderedMap.from(model));
}

function checkSet(s: OrderedSet<number>, model: number[]): void {
  expect([...s]).toEqual(model);
  const expected = anchorsFromScratch(model);
  for (let i = 0; i < model.length; i++) {
    expect(s.indexOf(model[i]!)).toBe(i);
    expect(s._anchorOf(model[i]!)).toBe(expected.get(model[i]));
  }
  expect(s).toBe(OrderedSet.from(model));
}

/** Apply one op to the model, returning what was done (or null when the op does not apply). */
function stepModel(model: [number, number][], o: Op): { t: 'set'; k: number; v: number } | { t: 'delete'; k: number } | { t: 'insert'; i: number; k: number; v: number } | null {
  const has = (k: number): boolean => model.some(([x]) => x === k);
  switch (o.t) {
    case 'append': {
      const at = model.findIndex(([x]) => x === o.k);
      if (at >= 0) model[at] = [o.k, o.v];
      else model.push([o.k, o.v]);
      return { t: 'set', k: o.k, v: o.v };
    }
    case 'setExisting': {
      if (model.length === 0) return null;
      const i = o.i % model.length;
      model[i] = [model[i]![0], o.v];
      return { t: 'set', k: model[i]![0], v: o.v };
    }
    case 'delete': {
      if (model.length === 0) return null;
      const i = o.i % model.length;
      const [k] = model.splice(i, 1)[0]!;
      return { t: 'delete', k };
    }
    case 'insert': {
      if (has(o.k)) return null;
      const i = o.i % (model.length + 1);
      model.splice(i, 0, [o.k, o.v]);
      return { t: 'insert', i, k: o.k, v: o.v };
    }
  }
}

describe('OrderedMap / OrderedSet — random sequences against the model', () => {
  it('persistent operations: content, positions, anchors and canonicality hold at every step', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        let m = OrderedMap.empty<number, number>();
        let s = OrderedSet.empty<number>();
        const model: [number, number][] = [];
        for (const o of ops) {
          const done = stepModel(model, o);
          if (done === null) continue;
          if (done.t === 'set') {
            m = m.set(done.k, done.v);
            s = s.add(done.k);
          } else if (done.t === 'delete') {
            m = m.delete(done.k);
            s = s.delete(done.k);
          } else {
            m = m.insertAt(done.i, done.k, done.v);
            s = s.insertAt(done.i, done.k);
          }
          checkMap(m, model);
          checkSet(
            s,
            model.map(([k]) => k),
          );
        }
      }),
      { numRuns: 150 },
    );
  });

  it('long sequences of appends and deletes cross leaf and branch boundaries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        let x = seed >>> 0;
        const rnd = (): number => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
        let m = OrderedMap.empty<number, number>();
        const model: [number, number][] = [];
        let next = 0;
        for (let r = 0; r < 400; r++) {
          if (model.length === 0 || rnd() < 0.6) {
            m = m.set(next, r);
            model.push([next++, r]);
          } else {
            const i = Math.floor(rnd() * model.length);
            m = m.delete(model[i]![0]);
            model.splice(i, 1);
          }
        }
        checkMap(m, model);
      }),
      { numRuns: 20 },
    );
  });

  it('deep trees: hundreds of mixed edits on 6,000 entries keep every position and the canonical instance', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        let x = seed >>> 0;
        const rnd = (): number => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
        const N = 6000;
        const model: [number, number][] = Array.from({ length: N }, (_, i) => [i, i]);
        let m = OrderedMap.from(model);
        let s = OrderedSet.from(model.map(([k]) => k));
        expect(m.keyList._height).toBeGreaterThanOrEqual(3);
        let next = N;
        for (let r = 0; r < 300; r++) {
          const p = rnd();
          if (p < 0.35) {
            const i = Math.floor(rnd() * model.length);
            const [k] = model.splice(i, 1)[0]!;
            m = m.delete(k);
            s = s.delete(k);
          } else if (p < 0.7) {
            const i = Math.floor(rnd() * (model.length + 1));
            model.splice(i, 0, [next, r]);
            m = m.insertAt(i, next, r);
            s = s.insertAt(i, next);
            next++;
          } else if (p < 0.85) {
            model.push([next, r]);
            m = m.set(next, r);
            s = s.add(next);
            next++;
          } else {
            const [k] = model.pop()!;
            m = m.delete(k);
            s = s.delete(k);
          }
        }
        expect([...m.keys()]).toEqual(model.map(([k]) => k));
        for (let i = 0; i < model.length; i++) {
          expect(m.indexOf(model[i]![0])).toBe(i);
          expect(s.indexOf(model[i]![0])).toBe(i);
        }
        expect(m).toBe(OrderedMap.from(model));
        expect(s).toBe(OrderedSet.from(model.map(([k]) => k)));
      }),
      { numRuns: 5 },
    );
  });

  it('through produce: the result is canonical, current() agrees, patches replay and invert', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), fc.array(op, { maxLength: 30 }), (setup, edits) => {
        const model: [number, number][] = [];
        for (const o of setup) stepModel(model, o);
        const base = OrderedMap.from(model);
        const baseSet = OrderedSet.from(model.map(([k]) => k));
        let snapshot: OrderedMap<number, number> | undefined;
        let snapshotSet: OrderedSet<number> | undefined;
        const [next, patches, inverse] = produceWithPatches(base, (d) => {
          for (const o of edits) {
            const done = stepModel(model, o);
            if (done === null) continue;
            if (done.t === 'set') d.set(done.k, done.v);
            else if (done.t === 'delete') expect(d.delete(done.k)).toBe(true);
            else d.insertAt(done.i, done.k, done.v);
          }
          snapshot = current(d);
        });
        expect(next).toBe(OrderedMap.from(model));
        expect(snapshot).toBe(next);
        expect(applyPatches(base, patches)).toBe(next);
        expect(applyPatches(next, inverse)).toBe(base);
        if (next === base) expect(patches).toEqual([]);
        const [nextSet, sp, si] = produceWithPatches(baseSet, (d) => {
          const keys = new Set(model.map(([k]) => k));
          for (const k of [...d]) if (!keys.has(k)) d.delete(k);
          d.clear();
          for (const [k] of model) d.add(k);
          snapshotSet = current(d);
        });
        expect(nextSet).toBe(OrderedSet.from(model.map(([k]) => k)));
        expect(snapshotSet).toBe(nextSet);
        expect(applyPatches(baseSet, sp)).toBe(nextSet);
        expect(applyPatches(nextSet, si)).toBe(baseSet);
      }),
      { numRuns: 200 },
    );
  });
});
