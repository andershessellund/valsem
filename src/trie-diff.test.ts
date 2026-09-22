// trieDiff — what one trie has that another does not, reported to visitors,
// against two oracles: the consing set algebra (`difference`) and a native
// model of the same edits. Pairs are built to share subtrees (one derived
// from the other by a few edits), so the pointer-skip is exercised, and to
// share nothing (independent builds), so every node is walked.
import { describe, it, expect } from 'vitest';
import { ValueSet } from './value-set.js';
import { ValueMap } from './value-map.js';
import { intern } from './intern.js';
import { mulberry32 } from './rng.test-helpers.js';

function setDiff(a: ValueSet<unknown>, b: ValueSet<unknown>): { onlyA: unknown[]; onlyB: unknown[] } {
  const onlyA: unknown[] = [];
  const onlyB: unknown[] = [];
  ValueSet._diff(a, b, (m) => onlyA.push(m), (m) => onlyB.push(m));
  return { onlyA, onlyB };
}
function mapDiff(a: ValueMap<unknown, unknown>, b: ValueMap<unknown, unknown>): { onlyA: unknown[]; onlyB: unknown[]; changed: [unknown, unknown, unknown][] } {
  const onlyA: unknown[] = [];
  const onlyB: unknown[] = [];
  const changed: [unknown, unknown, unknown][] = [];
  ValueMap._diff(a, b, (k) => onlyA.push(k), (k) => onlyB.push(k), (k, before, after) => changed.push([k, before, after]));
  return { onlyA, onlyB, changed };
}
/** Members are canonical, so a Set compares them by identity — and order-free. */
const asSet = (xs: unknown[]): Set<unknown> => new Set(xs);

describe('trieDiff on sets', () => {
  it('a set against itself, and against an equal build: nothing', () => {
    const a = ValueSet.from([1, 2, 3, 'x', intern({ k: 1 })]);
    expect(setDiff(a, a)).toEqual({ onlyA: [], onlyB: [] });
    expect(setDiff(a, ValueSet.from([intern({ k: 1 }), 'x', 3, 2, 1]))).toEqual({ onlyA: [], onlyB: [] });
    expect(setDiff(ValueSet.empty(), ValueSet.empty())).toEqual({ onlyA: [], onlyB: [] });
  });

  it('against the empty set, everything is one side', () => {
    const a = ValueSet.from(Array.from({ length: 300 }, (_, i) => i));
    expect(asSet(setDiff(a, ValueSet.empty()).onlyA)).toEqual(asSet([...a]));
    expect(setDiff(a, ValueSet.empty()).onlyB).toEqual([]);
    expect(asSet(setDiff(ValueSet.empty(), a).onlyB)).toEqual(asSet([...a]));
  });

  it('agrees with difference() on derived pairs (shared subtrees) and independent pairs, of every size', () => {
    const rnd = mulberry32(7);
    const int = (n: number): number => Math.floor(rnd() * n);
    for (let round = 0; round < 120; round++) {
      const n = [0, 1, 2, 5, 33, 200, 3000][int(7)]!;
      const members: unknown[] = Array.from({ length: n }, (_, i) => (i % 4 === 0 ? `s${i}` : i % 4 === 1 ? i : i % 4 === 2 ? intern({ o: i }) : intern([i])));
      const a = ValueSet.from(members);
      // b: derived from a by k edits (shares most nodes), or built independently over an overlapping range
      let b: ValueSet<unknown>;
      if (int(2) === 0) {
        b = a;
        const k = int(1 + Math.min(n, 40));
        for (let e = 0; e < k; e++) b = int(2) === 0 ? b.delete(members[int(Math.max(1, n))]) : b.add(int(2) === 0 ? `new${e}` : intern({ o: -e }));
      } else {
        const from = int(1 + n);
        b = ValueSet.from((Array.from({ length: int(1 + n) }, (_, i) => `s${i + from}`) as unknown[]).concat(members.slice(from)));
      }
      const { onlyA, onlyB } = setDiff(a, b);
      expect(asSet(onlyA), `round ${round}, n ${n}`).toEqual(asSet([...a.difference(b)]));
      expect(asSet(onlyB), `round ${round}, n ${n}`).toEqual(asSet([...b.difference(a)]));
      // no member reported twice, none on both sides
      expect(new Set(onlyA).size).toBe(onlyA.length);
      expect(onlyA.some((m) => onlyB.includes(m))).toBe(false);
    }
  });
});

describe('trieDiff on maps', () => {
  it('reports keys only in one, and a key in both under different values', () => {
    const a = ValueMap.from<unknown, unknown>([['k', 1], ['same', 'v'], ['gone', 0]]);
    const b = ValueMap.from<unknown, unknown>([['k', 2], ['same', 'v'], ['new', 0]]);
    const d = mapDiff(a, b);
    expect(d.onlyA).toEqual(['gone']);
    expect(d.onlyB).toEqual(['new']);
    expect(d.changed).toEqual([['k', 1, 2]]);
    expect(mapDiff(a, a)).toEqual({ onlyA: [], onlyB: [], changed: [] });
  });

  it('agrees with a native model on derived and independent pairs', () => {
    const rnd = mulberry32(11);
    const int = (n: number): number => Math.floor(rnd() * n);
    for (let round = 0; round < 120; round++) {
      const n = [0, 1, 3, 40, 500, 2500][int(6)]!;
      const entries: [unknown, unknown][] = Array.from({ length: n }, (_, i) => [i % 3 === 0 ? `k${i}` : i % 3 === 1 ? i : intern({ id: i }), { v: i }]);
      const a = ValueMap.from(entries);
      const model = new Map<unknown, unknown>(a);
      let b = a;
      const k = int(1 + Math.min(n + 5, 50));
      for (let e = 0; e < k; e++) {
        const which = int(3);
        if (which === 0 && n > 0) {
          const key = entries[int(n)]![0];
          b = b.delete(key);
          model.delete(intern(key));
        } else if (which === 1 && n > 0) {
          const key = entries[int(n)]![0];
          b = b.set(key, { v: -e });
          model.set(intern(key), intern({ v: -e }));
        } else {
          b = b.set(`new${e}`, e);
          model.set(`new${e}`, e);
        }
      }
      const d = mapDiff(a, b);
      const expOnlyA = [...a.keys()].filter((key) => !model.has(key));
      const expOnlyB = [...model.keys()].filter((key) => !a.has(key));
      const expChanged = [...a.keys()].filter((key) => model.has(key) && model.get(key) !== a.get(key));
      expect(asSet(d.onlyA), `round ${round}`).toEqual(asSet(expOnlyA));
      expect(asSet(d.onlyB), `round ${round}`).toEqual(asSet(expOnlyB));
      expect(asSet(d.changed.map((c) => c[0])), `round ${round}`).toEqual(asSet(expChanged));
      for (const [key, before, after] of d.changed) {
        expect(before).toBe(a.get(key));
        expect(after).toBe(model.get(key));
      }
    }
  });
});
