// ---------------------------------------------------------------------------
// Property suite: produce convergence.
//
// One op interpreter, two executions. Each generated op sequence is applied
// BOTH to a produce draft and to a plain mutable deep copy of the canonical
// base. The oracles, all `===` thanks to canonicality:
//
//   1. produce(base, ops)            === intern(mutate(clone(base), ops))
//   2. applyPatches(base, patches)   === result
//   3. applyPatches(result, inverse) === base
//   4. result === base  ⟹  no patches were emitted
//
// Oracle 1 says produce is exactly "mutate a copy, then intern" — the
// semantics contract. Oracles 2/3 pin patch soundness both directions.
// A second property runs the same scheme over collection drafts
// (DraftMap/DraftSet/DraftList) against native Map/Set/array mirrors.
// ---------------------------------------------------------------------------

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { intern } from './intern.js';
import { applyPatches, produceWithPatches } from './produce.js';
import { ValueList } from './value-list.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { mutableClone, plainTree } from './property.test-helpers.js';

// --- op model over plain data ----------------------------------------------

const payload: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: 0, max: 4 }),
  fc.constantFrom('x', 'y', null, undefined, true),
  fc.record({ a: fc.integer({ min: 0, max: 3 }) }),
  fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 2 }),
);

const smallKey = fc.constantFrom('a', 'b', 'c', 'd', 'zz');

type Action =
  | { t: 'setKey'; k: string; v: unknown }
  | { t: 'delKey'; k: string }
  | { t: 'push'; v: unknown }
  | { t: 'pop' }
  | { t: 'shift' }
  | { t: 'unshift'; v: unknown }
  | { t: 'setIdx'; i: number; v: unknown }
  | { t: 'splice'; i: number; d: number; vs: unknown[] }
  | { t: 'reverse' }
  | { t: 'setLen'; n: number };

interface Op {
  path: number[];
  action: Action;
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ t: fc.constant('setKey' as const), k: smallKey, v: payload }),
  fc.record({ t: fc.constant('delKey' as const), k: smallKey }),
  fc.record({ t: fc.constant('push' as const), v: payload }),
  fc.record({ t: fc.constant('pop' as const) }),
  fc.record({ t: fc.constant('shift' as const) }),
  fc.record({ t: fc.constant('unshift' as const), v: payload }),
  fc.record({ t: fc.constant('setIdx' as const), i: fc.integer({ min: 0, max: 6 }), v: payload }),
  fc.record({
    t: fc.constant('splice' as const),
    i: fc.integer({ min: 0, max: 6 }),
    d: fc.integer({ min: 0, max: 3 }),
    vs: fc.array(payload, { maxLength: 3 }),
  }),
  fc.record({ t: fc.constant('reverse' as const) }),
  fc.record({ t: fc.constant('setLen' as const), n: fc.integer({ min: 0, max: 6 }) }),
);

const opArb: fc.Arbitrary<Op> = fc.record({
  path: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
  action: actionArb,
});

// --- the single interpreter (runs on drafts AND on mutable mirrors) --------

// Containers the interpreter may descend into and mutate: arrays and plain
// records only. InternedString instances (frozen leaf objects) must not be
// targeted by record ops.
function isContainer(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function locate(root: unknown, path: number[]): unknown {
  let node = root;
  for (const p of path) {
    let next: unknown;
    if (Array.isArray(node)) {
      if (node.length === 0) break;
      next = node[p % node.length];
    } else {
      const rec = node as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      if (keys.length === 0) break;
      next = rec[keys[p % keys.length]!];
    }
    if (!isContainer(next)) break;
    node = next;
  }
  return node;
}

function applyOp(root: unknown, op: Op): void {
  if (!isContainer(root)) return;
  const node = locate(root, op.path);
  const a = op.action;
  // Inserted payloads are cloned at the insertion site: the same op object is
  // applied to BOTH the mirror and the draft, and a shared instance mutated
  // by one pass would corrupt the other (up to and including building a
  // cyclic value, which the value domain excludes).
  if (Array.isArray(node)) {
    switch (a.t) {
      case 'push':
        node.push(mutableClone(a.v));
        break;
      case 'pop':
        node.pop();
        break;
      case 'shift':
        node.shift();
        break;
      case 'unshift':
        node.unshift(mutableClone(a.v));
        break;
      case 'setIdx':
        node[a.i] = mutableClone(a.v);
        break;
      case 'splice':
        node.splice(Math.min(a.i, node.length), a.d, ...a.vs.map(mutableClone));
        break;
      case 'reverse':
        node.reverse();
        break;
      case 'setLen':
        node.length = a.n;
        break;
      default:
        break; // record actions are no-ops on arrays
    }
  } else {
    const rec = node as Record<string, unknown>;
    switch (a.t) {
      case 'setKey':
        rec[a.k] = mutableClone(a.v);
        break;
      case 'delKey':
        delete rec[a.k];
        break;
      default:
        break; // array actions are no-ops on records
    }
  }
}

describe('property — produce convergence (plain data)', () => {
  it('produce ≡ mutate-clone-then-intern; patches round-trip both ways', () => {
    fc.assert(
      fc.property(plainTree, fc.array(opArb, { maxLength: 12 }), (raw, ops) => {
        const base = intern(raw);
        const mirror = mutableClone(base);
        for (const op of ops) applyOp(mirror, op);
        const expected = intern(mirror);

        const [actual, patches, inverse] = produceWithPatches(base, (d) => {
          for (const op of ops) applyOp(d, op);
        });

        expect(actual).toBe(expected);
        expect(applyPatches(base, patches)).toBe(actual);
        expect(applyPatches(actual, inverse)).toBe(base);
        if (actual === base) {
          expect(patches).toEqual([]);
          expect(inverse).toEqual([]);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// --- collection drafts vs native mirrors -----------------------------------

type CollAction =
  | { t: 'mset'; k: unknown; v: unknown }
  | { t: 'mdel'; k: unknown }
  | { t: 'sadd'; v: unknown }
  | { t: 'sdel'; v: unknown }
  | { t: 'lpush'; v: unknown }
  | { t: 'lpop' }
  | { t: 'lset'; i: number; v: unknown };

const collActionArb: fc.Arbitrary<CollAction> = fc.oneof(
  fc.record({ t: fc.constant('mset' as const), k: payload, v: payload }),
  fc.record({ t: fc.constant('mdel' as const), k: payload }),
  fc.record({ t: fc.constant('sadd' as const), v: payload }),
  fc.record({ t: fc.constant('sdel' as const), v: payload }),
  fc.record({ t: fc.constant('lpush' as const), v: payload }),
  fc.record({ t: fc.constant('lpop' as const) }),
  fc.record({ t: fc.constant('lset' as const), i: fc.integer({ min: 0, max: 5 }), v: payload }),
);

describe('property — produce convergence (collection drafts)', () => {
  it('DraftMap/DraftSet/DraftList ≡ native Map/Set/array mirrors', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(payload, payload), { maxLength: 5 }),
        fc.array(payload, { maxLength: 5 }),
        fc.array(payload, { maxLength: 5 }),
        fc.array(collActionArb, { maxLength: 14 }),
        (mEntries, sItems, lItems, actions) => {
          const base = intern({
            m: ValueMap.from(mEntries),
            s: ValueSet.from(sItems),
            l: ValueList.from(lItems),
          });

          // Mirrors keyed by canonical references so structural keys behave.
          const mm = new Map<unknown, unknown>(base.m.entries());
          const sm = new Set<unknown>(base.s.values());
          const lm = [...base.l.toArray()];
          for (const a of actions) {
            switch (a.t) {
              case 'mset':
                mm.set(intern(a.k), a.v);
                break;
              case 'mdel':
                mm.delete(intern(a.k));
                break;
              case 'sadd':
                sm.add(intern(a.v));
                break;
              case 'sdel':
                sm.delete(intern(a.v));
                break;
              case 'lpush':
                lm.push(a.v);
                break;
              case 'lpop':
                lm.pop();
                break;
              case 'lset':
                if (lm.length > 0) lm[a.i % lm.length] = a.v;
                break;
            }
          }
          const expected = intern({
            m: ValueMap.from(mm.entries()),
            s: ValueSet.from(sm.values()),
            l: ValueList.from(lm),
          });

          const [actual, patches, inverse] = produceWithPatches(base, (d) => {
            for (const a of actions) {
              switch (a.t) {
                case 'mset':
                  d.m.set(a.k, a.v);
                  break;
                case 'mdel':
                  d.m.delete(a.k);
                  break;
                case 'sadd':
                  d.s.add(a.v);
                  break;
                case 'sdel':
                  d.s.delete(a.v);
                  break;
                case 'lpush':
                  d.l.push(a.v);
                  break;
                case 'lpop':
                  d.l.pop();
                  break;
                case 'lset':
                  if (d.l.length > 0) d.l.set(a.i % d.l.length, a.v);
                  break;
              }
            }
          });

          expect(actual).toBe(expected);
          expect(applyPatches(base, patches)).toBe(actual);
          expect(applyPatches(actual, inverse)).toBe(base);
          if (actual === base) {
            expect(patches).toEqual([]);
            expect(inverse).toEqual([]);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
