// ---------------------------------------------------------------------------
// Property suite: the patch laws under aliasing.
//
//   1. applyPatches(base, patches)   === result
//   2. applyPatches(result, inverse) === base
//   3. result === base  ⟹  no patches, no inverses
//
// property-produce.test.ts holds the same laws over a mirror-checked op model,
// but that model never puts ONE draft in two places, never assigns an original
// back over its edited draft, and never edits a value after assigning it.
// Those three shapes are exactly where patch emission went wrong (external
// review, finding 3): memoised finalize skipped an aliased child's patches,
// assign-back was recorded as a deletion, and sequence ops kept the value as
// it was before its copy-on-write edits. No mirror is needed to check them:
// the laws are self-consistency, and every comparison is `===`.
// ---------------------------------------------------------------------------
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { intern } from './intern.js';
import { applyPatches, produceWithPatches, type Patch } from './produce.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { OrderedMap } from './ordered-map.js';
import { expectPatchRoundTrip } from './patches.test-helpers.js';

type Leaf = { x: number; y?: number };
type Rec = { x: number; y?: number; n: { k: number } };
interface State {
  a: Rec;
  b: Rec;
  c?: Rec | Leaf;
  arr: (Leaf | Rec)[];
  m: ValueMap<string, Leaf | Rec>;
  l: ValueList<Leaf | Rec>;
  o: OrderedMap<string, Leaf | Rec>;
}

const leaf = (x: number): Leaf => intern({ x });
const base: State = intern({
  a: { x: 0, n: { k: 0 } },
  b: { x: 1, n: { k: 1 } },
  arr: [{ x: 10 }, { x: 11 }, { x: 12 }],
  m: ValueMap.from<string, Leaf | Rec>([['p', { x: 20 }], ['q', { x: 21 }]]),
  l: ValueList.of<Leaf | Rec>({ x: 30 }, { x: 31 }),
  o: OrderedMap.from<string, Leaf | Rec>([['p', { x: 40 }], ['q', { x: 41 }]]),
});

const SLOTS = ['a', 'b', 'c'] as const;
const KEYS = ['p', 'q', 'r'] as const;
const slot = fc.constantFrom(...SLOTS);
const key = fc.constantFrom(...KEYS);
const idx = fc.integer({ min: 0, max: 3 });
const val = fc.integer({ min: 0, max: 2 });

type Op =
  | { t: 'edit'; s: (typeof SLOTS)[number]; v: number }
  | { t: 'editDeep'; s: 'a' | 'b'; v: number }
  | { t: 'alias'; from: (typeof SLOTS)[number]; to: (typeof SLOTS)[number] }
  | { t: 'assignBack'; s: 'a' | 'b' }
  | { t: 'assignCanon'; s: (typeof SLOTS)[number]; v: number }
  | { t: 'editAfter'; s: (typeof SLOTS)[number]; v: number }
  | { t: 'del'; s: 'c' }
  | { t: 'arrSet' | 'arrEdit' | 'arrPush' | 'arrUnshift'; i: number; v: number }
  | { t: 'arrAlias' | 'arrBack' | 'arrSplice' | 'arrPop' | 'arrSort'; i: number }
  | { t: 'arrFromSlot'; s: 'a' | 'b'; i: number }
  | { t: 'mapSet' | 'mapEdit'; k: string; v: number }
  | { t: 'mapAlias'; from: string; to: string }
  | { t: 'mapFromSlot'; s: 'a' | 'b'; k: string }
  | { t: 'mapDelete' | 'mapRefill'; k: string }
  | { t: 'listSet' | 'listEdit' | 'listPush'; i: number; v: number }
  | { t: 'listAlias' | 'listPop'; i: number }
  | { t: 'omapSet' | 'omapEdit'; k: string; v: number }
  | { t: 'omapAlias'; from: string; to: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('edit' as const), s: slot, v: val }),
  fc.record({ t: fc.constant('editDeep' as const), s: fc.constantFrom('a' as const, 'b' as const), v: val }),
  fc.record({ t: fc.constant('alias' as const), from: slot, to: slot }),
  fc.record({ t: fc.constant('assignBack' as const), s: fc.constantFrom('a' as const, 'b' as const) }),
  fc.record({ t: fc.constant('assignCanon' as const), s: slot, v: val }),
  fc.record({ t: fc.constant('editAfter' as const), s: slot, v: val }),
  fc.record({ t: fc.constant('del' as const), s: fc.constant('c' as const) }),
  fc.record({ t: fc.constantFrom('arrSet' as const, 'arrEdit' as const, 'arrPush' as const, 'arrUnshift' as const), i: idx, v: val }),
  fc.record({ t: fc.constantFrom('arrAlias' as const, 'arrBack' as const, 'arrSplice' as const, 'arrPop' as const, 'arrSort' as const), i: idx }),
  fc.record({ t: fc.constant('arrFromSlot' as const), s: fc.constantFrom('a' as const, 'b' as const), i: idx }),
  fc.record({ t: fc.constantFrom('mapSet' as const, 'mapEdit' as const), k: key, v: val }),
  fc.record({ t: fc.constant('mapAlias' as const), from: key, to: key }),
  fc.record({ t: fc.constant('mapFromSlot' as const), s: fc.constantFrom('a' as const, 'b' as const), k: key }),
  fc.record({ t: fc.constantFrom('mapDelete' as const, 'mapRefill' as const), k: key }),
  fc.record({ t: fc.constantFrom('listSet' as const, 'listEdit' as const, 'listPush' as const), i: idx, v: val }),
  fc.record({ t: fc.constantFrom('listAlias' as const, 'listPop' as const), i: idx }),
  fc.record({ t: fc.constantFrom('omapSet' as const, 'omapEdit' as const), k: key, v: val }),
  fc.record({ t: fc.constant('omapAlias' as const), from: key, to: key }),
);

type D = import('./produce.js').Draft<State>;

function run(d: D, o: Op): void {
  const rec = d as unknown as Record<string, Leaf | Rec | undefined>;
  switch (o.t) {
    case 'edit': { const r = rec[o.s]; if (r) r.x = o.v; break; }
    case 'editDeep': d[o.s].n.k = o.v; break;
    case 'alias': { const r = rec[o.from]; if (r && o.to === 'c') rec.c = r; else if (r && o.from !== 'c') rec[o.to] = r; break; }
    case 'assignBack': rec[o.s] = base[o.s]; break;
    case 'assignCanon': if (o.s === 'c') rec.c = leaf(o.v); else rec[o.s] = intern({ x: o.v, n: { k: o.v } }); break;
    case 'editAfter': { const r = rec[o.s]; if (r) r.y = o.v; break; }
    case 'del': delete rec.c; break;
    case 'arrSet': if (o.i < d.arr.length) d.arr[o.i] = leaf(o.v); break;
    case 'arrEdit': { const e = d.arr[o.i]; if (e) e.y = o.v; break; }
    case 'arrPush': d.arr.push(leaf(o.v)); break;
    case 'arrUnshift': d.arr.unshift(leaf(o.v)); break;
    case 'arrAlias': { const e = d.arr[o.i]; if (e) d.arr.push(e); break; }
    case 'arrBack': if (o.i < d.arr.length && o.i < base.arr.length) d.arr[o.i] = base.arr[o.i]!; break;
    case 'arrSplice': if (o.i < d.arr.length) d.arr.splice(o.i, 1); break;
    case 'arrPop': d.arr.pop(); break;
    case 'arrSort': d.arr.sort((p, q) => q.x - p.x); break;
    case 'arrFromSlot': if (o.i < d.arr.length) d.arr[o.i] = d[o.s]; else d.arr.push(d[o.s]); break;
    case 'mapSet': d.m.set(o.k, leaf(o.v)); break;
    case 'mapEdit': { const e = d.m.get(o.k); if (e) e.y = o.v; break; }
    case 'mapAlias': { const e = d.m.get(o.from); if (e) d.m.set(o.to, e as Leaf); break; }
    case 'mapFromSlot': d.m.set(o.k, d[o.s] as Rec); break;
    case 'mapDelete': d.m.delete(o.k); break;
    case 'mapRefill': { const entries = [...base.m]; d.m.clear(); for (const [k, v] of entries) d.m.set(k, v); break; }
    case 'listSet': if (o.i < d.l.length) d.l.set(o.i, leaf(o.v)); break;
    case 'listEdit': if (o.i < d.l.length) d.l.at(o.i)!.y = o.v; break;
    case 'listPush': d.l.push(leaf(o.v)); break;
    case 'listAlias': if (o.i < d.l.length) d.l.push(d.l.at(o.i) as Leaf); break;
    case 'listPop': d.l.pop(); break;
    case 'omapSet': d.o.set(o.k, leaf(o.v)); break;
    case 'omapEdit': { const e = d.o.get(o.k); if (e) e.y = o.v; break; }
    case 'omapAlias': { const e = d.o.get(o.from); if (e) d.o.set(o.to, e as Leaf); break; }
  }
}

const check = (ops: Op[]): void => {
  const [result, patches, inverse] = produceWithPatches(base, (d) => {
    for (const o of ops) run(d, o);
  });
  expectPatchRoundTrip(base, result, patches, inverse);
  if (result === base) {
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  }
  // Patches are data: they survive being copied, and applying them leaves them as they were.
  const copy = structuredClonePatches(patches);
  expect(applyPatches(base, patches)).toBe(result);
  expect(structuredClonePatches(patches)).toEqual(copy);
};

/** A structural copy that keeps canonical values by reference (they are immutable). */
function structuredClonePatches(patches: readonly Patch[]): unknown[] {
  return patches.map((p) => ({ ...p, path: [...p.path] }));
}

describe('property — the patch laws under aliasing, assign-back and edit-after-assign', () => {
  it('applyPatches(base, patches) === result, and the inverses lead back', () => {
    fc.assert(fc.property(fc.array(op, { maxLength: 12 }), check), { numRuns: 1500 });
  });

  it('the four reviewed shapes, pinned', () => {
    // 3a. one modified child in two places
    check([{ t: 'edit', s: 'a', v: 2 }, { t: 'alias', from: 'a', to: 'c' }]);
    check([{ t: 'arrEdit', i: 0, v: 1 }, { t: 'arrAlias', i: 0 }]);
    check([{ t: 'mapEdit', k: 'p', v: 1 }, { t: 'mapAlias', from: 'p', to: 'r' }]);
    check([{ t: 'listEdit', i: 0, v: 1 }, { t: 'listAlias', i: 0 }]);
    check([{ t: 'omapEdit', k: 'p', v: 1 }, { t: 'omapAlias', from: 'p', to: 'r' }]);
    check([{ t: 'editDeep', s: 'a', v: 2 }, { t: 'arrFromSlot', s: 'a', i: 9 }, { t: 'mapFromSlot', s: 'a', k: 'r' }]);
    check([{ t: 'arrEdit', i: 1, v: 1 }, { t: 'arrAlias', i: 1 }, { t: 'arrUnshift', i: 0, v: 0 }]); // unstable positions
    // 3b. the original assigned back over its edited draft
    check([{ t: 'edit', s: 'a', v: 2 }, { t: 'assignBack', s: 'a' }, { t: 'edit', s: 'b', v: 2 }]);
    check([{ t: 'arrEdit', i: 0, v: 1 }, { t: 'arrBack', i: 0 }, { t: 'arrPush', i: 0, v: 1 }]);
    // 3c. edited after being assigned
    check([{ t: 'arrSet', i: 0, v: 1 }, { t: 'arrEdit', i: 0, v: 2 }]);
    check([{ t: 'arrPush', i: 0, v: 1 }, { t: 'arrEdit', i: 3, v: 2 }]);
    check([{ t: 'listSet', i: 0, v: 1 }, { t: 'listEdit', i: 0, v: 2 }]);
    check([{ t: 'listPush', i: 0, v: 1 }, { t: 'listEdit', i: 2, v: 2 }]);
    check([{ t: 'assignCanon', s: 'c', v: 1 }, { t: 'editAfter', s: 'c', v: 2 }]);
    // and a sequence that nets out to the base emits nothing
    check([{ t: 'mapRefill', k: 'p' }]);
  });
});

describe('applyPatches does not write into the values it is given', () => {
  it('a later patch that edits inside an earlier patch value leaves the caller’s object alone', () => {
    const value = { x: 1, inner: { n: 1 }, list: [1] };
    const patches: Patch[] = [
      { kind: 'record.set', path: [], key: 'a', value },
      { kind: 'record.set', path: ['a'], key: 'y', value: 2 },
      { kind: 'record.set', path: ['a', 'inner'], key: 'n', value: 9 },
      { kind: 'list.splice', path: ['a', 'list'], index: 1, remove: 0, insert: [{ deep: 1 }] },
    ];
    const result = applyPatches(intern({}), patches);
    expect(result).toBe(intern({ a: { x: 1, y: 2, inner: { n: 9 }, list: [1, { deep: 1 }] } }));
    expect(value).toEqual({ x: 1, inner: { n: 1 }, list: [1] });
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('through the collections too', () => {
    const v = { x: 1 };
    const inserted = { z: 1 };
    applyPatches(ValueMap.from<string, unknown>([]), [
      { kind: 'map.set', path: [], key: 'k', value: v },
      { kind: 'record.set', path: ['k'], key: 'y', value: 2 },
    ]);
    applyPatches(ValueList.of<unknown>(), [
      { kind: 'list.splice', path: [], index: 0, remove: 0, insert: [inserted] },
      { kind: 'record.set', path: [0], key: 'w', value: 2 },
    ]);
    expect(v).toEqual({ x: 1 });
    expect(inserted).toEqual({ z: 1 });
  });
});
