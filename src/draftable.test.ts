// ---------------------------------------------------------------------------
// Bring your own draftable: a third-party value type that produce can draft,
// built with nothing but the public `valsem/draft` toolkit — the same route
// ValueMap/ValueSet/ValueList take. This file is also the worked example the
// guide shows.
// ---------------------------------------------------------------------------
import { describe, it, expect, expectTypeOf } from 'vitest';
import { produce, produceWithPatches, applyPatches, type Draft } from './produce.js';
import {
  toDraft,
  DRAFT_STATE,
  createDraftState,
  markChanged,
  assertUnrevoked,
  createChildDraft,
  resolve,
  isDraftable,
  isDraft,
  type DraftState,
  type PatchPath,
  type PatchRecorder,
  type Patch,
} from './draft.js';
import { equals, hashCode, interned, deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { createInternPool } from './intern-pool.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';

// A custom patch kind, registered by declaration merging so it narrows exactly.
declare module './draft-core.js' {
  interface PatchKinds {
    'interval.set': { kind: 'interval.set'; path: PatchPath; lo: number; hi: number };
  }
}

// ---- the value type ------------------------------------------------------

const pool = createInternPool<Interval>();

/** A canonical closed interval with a plain-record `meta` — a value with a nested record inside. */
class Interval {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;
  private constructor(
    readonly lo: number,
    readonly hi: number,
    readonly meta: { label: string },
  ) {}
  [equals](o: unknown): boolean {
    return o instanceof Interval && o.lo === this.lo && o.hi === this.hi && o.meta === this.meta;
  }
  static of(lo: number, hi: number, meta: { label: string } = { label: '' }): Interval {
    const m = intern(meta); // canonicalise the nested record so [equals] can compare it by identity
    const iv = new Interval(lo, hi, m);
    (iv as unknown as Record<symbol, unknown>)[hashCode] = deepHash([lo, hi, m]);
    return pool.intern(iv);
  }

  // The protocol: produce calls this to draft an Interval.
  [toDraft](parent?: DraftState): IntervalState {
    const state = createDraftState<IntervalState>({
      kind: 'interval',
      parent,
      base: this,
      lo: this.lo,
      hi: this.hi,
      meta: this.meta, // replaced by a child draft on first read
      draft: null as unknown as IntervalDraft,
      finalize: finalizeInterval,
      applyPatch: applyIntervalPatch,
      childAt: (state, segment) => (segment === 'meta' ? (state as IntervalState).draft.meta : undefined),
    });
    state.draft = new IntervalDraft(state);
    return state;
  }
}

interface IntervalState extends DraftState<Interval> {
  kind: 'interval';
  lo: number;
  hi: number;
  meta: unknown;
  draft: IntervalDraft;
}

// ---- the draft -----------------------------------------------------------

class IntervalDraft {
  declare readonly [DRAFT_STATE]: IntervalState;
  constructor(state: IntervalState) {
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }
  get #state(): IntervalState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }
  get lo(): number {
    return this.#state.lo;
  }
  set lo(v: number) {
    const s = this.#state;
    if (v === s.lo) return;
    s.lo = v;
    markChanged(s);
  }
  get hi(): number {
    return this.#state.hi;
  }
  set hi(v: number) {
    const s = this.#state;
    if (v === s.hi) return;
    s.hi = v;
    markChanged(s);
  }
  /** The nested record, drafted lazily on first read — like any nested value. */
  get meta(): { label: string } {
    const s = this.#state;
    if (!isDraft(s.meta) && isDraftable(s.meta)) s.meta = createChildDraft(s.meta, s);
    return s.meta as { label: string };
  }
}

function finalizeInterval(state: DraftState<Interval>, path: PatchPath | null, recorder: PatchRecorder | undefined): unknown {
  const s = state as IntervalState;
  // Children resolve first (their patches land under [...path, 'meta']).
  const meta = resolve(s.meta, path === null ? null : [...path, 'meta'], recorder) as { label: string };
  const result = Interval.of(s.lo, s.hi, meta);
  s.result = result;
  if (recorder !== undefined && path !== null && (s.lo !== s.base.lo || s.hi !== s.base.hi)) {
    recorder.patches.push({ kind: 'interval.set', path, lo: s.lo, hi: s.hi });
    recorder.inverse.unshift({ kind: 'interval.set', path, lo: s.base.lo, hi: s.base.hi });
  }
  return result;
}

function applyIntervalPatch(state: DraftState<Interval>, p: Patch): void {
  if (p.kind !== 'interval.set') throw new Error(`cannot apply ${p.kind} to an interval`);
  const d = (state as IntervalState).draft;
  d.lo = p.lo;
  d.hi = p.hi;
}

// ---- the tests -----------------------------------------------------------

describe('a third-party draftable', () => {
  it('is recognised, drafted, and finalized to the canonical value', () => {
    const iv = Interval.of(0, 10);
    expect(isDraftable(iv)).toBe(true);
    const next = produce(iv, (d) => {
      expect(isDraft(d)).toBe(true);
      expect(d.lo).toBe(0);
      d.hi = 20;
    });
    expect(next).toBe(Interval.of(0, 20));
    expect(next).not.toBe(iv);
  });

  it('a no-op recipe, or edits that net out, return the same instance', () => {
    const iv = Interval.of(1, 2);
    expect(produce(iv, () => {})).toBe(iv);
    expect(produce(iv, (d) => void ((d.hi = 9), (d.hi = 2)))).toBe(iv);
  });

  it('nests inside records and lists, and holds a draftable record of its own', () => {
    const state = intern({ range: Interval.of(0, 10, { label: 'a' }), other: 1 });
    const next = produce(state, (d) => {
      d.range.hi = 5;
      d.range.meta.label = 'b'; // a plain record drafted through the custom draft
    });
    expect(next.range).toBe(Interval.of(0, 5, { label: 'b' }));
    expect(next.other).toBe(1);
    expect(deepEqual(next, intern({ other: 1, range: Interval.of(0, 5, { label: 'b' }) }))).toBe(true);

    const list = ValueList.of(Interval.of(1, 2), Interval.of(3, 4));
    const bumped = produce(list, (d) => {
      d.get(1)!.hi = 40; // DraftList child-drafts a custom draftable like any other
    });
    expect(bumped).toBe(ValueList.of(Interval.of(1, 2), Interval.of(3, 40)));
  });

  it('emits its own patch kind, and applyPatches routes it back through applyPatch', () => {
    const base = intern({ range: Interval.of(0, 10, { label: 'a' }) });
    const [next, patches, inverse] = produceWithPatches(base, (d) => {
      d.range.lo = 2;
      d.range.meta.label = 'z';
    });
    expect(patches).toEqual([
      { kind: 'record.set', path: ['range', 'meta'], key: 'label', value: 'z' },
      { kind: 'interval.set', path: ['range'], lo: 2, hi: 10 },
    ]);
    expect(applyPatches(base, patches)).toBe(next);
    expect(applyPatches(next, inverse)).toBe(base);
  });

  it('escaped drafts throw the teaching error', () => {
    let leaked: IntervalDraft | undefined;
    produce(Interval.of(0, 1), (d) => {
      leaked = d;
    });
    expect(() => leaked!.lo).toThrow(/escaped its produce\(\) call/);
  });

  it('cannot create a draft state outside a recipe', () => {
    expect(() => Interval.of(0, 1)[toDraft]()).toThrow(/inside a produce\(\) recipe/);
  });

  it('Draft<T> infers the draft type from [toDraft]', () => {
    expectTypeOf<Draft<Interval>>().toEqualTypeOf<IntervalDraft>();
    expectTypeOf<Draft<{ range: Interval }>>().toEqualTypeOf<{ range: IntervalDraft }>();
    expectTypeOf<Draft<ValueList<Interval>>['get']>().returns.toEqualTypeOf<IntervalDraft | undefined>(); // drafts all the way down
  });
});
