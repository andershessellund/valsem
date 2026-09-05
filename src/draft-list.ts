// ---------------------------------------------------------------------------
// DraftList — the mutable draft twin of ValueList, and its finalize.
//
// ValueList implements the `[toDraft]` protocol (see draft-core.ts) by calling
// createListDraft; produce never imports this module. It rides the same
// toolkit any third-party draftable would.
// ---------------------------------------------------------------------------

import {
  DRAFT_STATE,
  createDraftState,
  stateOf,
  isDraftable,
  same,
  markChanged,
  assertUnrevoked,
  assertAssignable,
  createChildDraft,
  resolve,
  snapshotOf,
  emitSeqOps,
  retractSeqPatches,
  seqTailProfile,
  type SeqOp,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
} from './draft-core.js';
import type { ValueList } from './value-list.js';
import type { Draft } from './produce.js';

const INTERNAL = Symbol('valsem.draftInternal');

export interface ListState<T = unknown> extends DraftState<ValueList<T>> {
  kind: 'list';
  /** Builds the canonical list for an item array (mid-sequence splices rebuild). */
  from: (items: unknown[]) => ValueList<unknown>;
  /**
   * Virtual mode (items === null): point edits over the base plus an
   * appended tail — no O(n) materialization for get/set/push/pop flows.
   */
  vEdits: Map<number, unknown>;
  vTail: unknown[];
  /** Materialized working array — created only when a splice forces it. */
  items: unknown[] | null;
  /** Always recorded for lists (never goes opaque). */
  ops: SeqOp[];
  /** Indices whose base value was child-drafted on read. */
  drafted: Set<number>;
  draft: DraftList<T>;
}

export class DraftList<T> {
  declare readonly [DRAFT_STATE]: ListState<T>;

  constructor(token: symbol, state: ListState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftList instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): ListState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }

  /** Fold the virtual edits/tail into a materialized working array. */
  #materialize(): unknown[] {
    const s = this.#state;
    if (s.items === null) {
      const items = [...s.base.toArray()]; // spread: the snapshot is frozen
      for (const [i, v] of s.vEdits) items[i] = v;
      items.push(...s.vTail);
      s.items = items;
      s.vEdits.clear();
      s.vTail.length = 0;
    }
    return s.items;
  }

  get length(): number {
    const s = this.#state;
    return s.items === null ? s.base.length + s.vTail.length : s.items.length;
  }

  /** Current value at `index`; only base-positioned values are child-drafted. */
  #read(index: number): unknown {
    const s = this.#state;
    if (s.items !== null) return s.items[index];
    if (index < s.base.length) {
      return s.vEdits.has(index) ? s.vEdits.get(index) : s.base.get(index);
    }
    return s.vTail[index - s.base.length];
  }

  get(index: number): Draft<T> | undefined {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    const value = this.#read(index);
    // Draft values still at their base position (assigned/inserted material
    // is the caller's own and comes back raw — the immer rule), and frozen
    // assigned values (canonicals must copy-on-write, not throw — mutative's
    // #18 family).
    if (
      isDraftable(value) &&
      !s.finalized &&
      stateOf(value) === undefined &&
      (value === s.base.get(index) || Object.isFrozen(value))
    ) {
      const child = createChildDraft(value, s);
      s.drafted.add(index);
      if (s.items !== null) s.items[index] = child;
      else s.vEdits.set(index, child);
      return child as Draft<T>;
    }
    return value as Draft<T>;
  }

  set(index: number, value: T): this {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`DraftList.set: index ${index} out of range [0, ${this.length})`);
    }
    const current = this.#read(index);
    if (same(current, value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    s.ops.push({ t: 'set', i: index, value, old: current });
    if (s.items !== null) s.items[index] = value;
    else if (index < s.base.length) s.vEdits.set(index, value);
    else s.vTail[index - s.base.length] = value;
    return this;
  }

  push(...values: T[]): number {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    markChanged(s);
    const len = this.length;
    s.ops.push({ t: 'splice', i: len, rc: 0, inserted: values.slice(), removed: [] });
    if (s.items !== null) s.items.push(...values);
    else s.vTail.push(...values);
    return len + values.length;
  }

  pop(): T | undefined {
    const s = this.#state;
    const len = this.length;
    if (len === 0) return undefined;
    markChanged(s);
    let removed: unknown;
    if (s.items !== null) {
      removed = s.items.pop();
    } else if (s.vTail.length > 0) {
      removed = s.vTail.pop();
    } else {
      removed = this.#materialize().pop();
    }
    s.ops.push({ t: 'splice', i: len - 1, rc: 1, inserted: [], removed: [removed] });
    return removed as T;
  }

  splice(start: number, deleteCount?: number, ...values: T[]): T[] {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    const items = this.#materialize();
    const len = items.length;
    let at = Math.trunc(start);
    at = at < 0 ? Math.max(len + at, 0) : Math.min(at, len);
    const rc =
      deleteCount === undefined
        ? len - at
        : Math.min(Math.max(Math.trunc(deleteCount), 0), len - at);
    markChanged(s);
    const removed = items.splice(at, rc, ...values);
    s.ops.push({
      t: 'splice',
      i: at,
      rc,
      inserted: values.slice(),
      removed: removed.slice(),
    });
    return removed as T[];
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const s = this.#state;
    if (s.items !== null) {
      yield* s.items as T[];
    } else if (s.vEdits.size === 0 && s.vTail.length === 0) {
      yield* s.base as Iterable<T>;
    } else {
      const baseLen = s.base.length;
      for (let i = 0; i < baseLen; i++) {
        yield (s.vEdits.has(i) ? s.vEdits.get(i) : s.base.get(i)) as T;
      }
      yield* s.vTail as T[];
    }
  }

  toArray(): readonly T[] {
    return [...this];
  }
}

/** Draft `base` under `parent`; `from` rebuilds a canonical list when a splice forces it. */
export function createListDraft<T>(
  base: ValueList<T>,
  parent: DraftState | undefined,
  from: (items: unknown[]) => ValueList<unknown>,
): ListState<T> {
  const state = createDraftState<ListState>({
    kind: 'list',
    parent,
    base: base as ValueList<unknown>,
    from,
    vEdits: new Map(),
    vTail: [],
    items: null,
    ops: [],
    drafted: new Set(),
    draft: null as unknown as DraftList<unknown>,
    finalize: finalizeList,
    snapshot: snapshotList,
    applyPatch: applyListPatch,
    childAt: (state, segment) => (state as ListState).draft.get(segment as number),
  });
  state.draft = new DraftList(INTERNAL, state);
  return state as ListState<T>;
}

function applyListPatch(state: ListState, p: Patch): void {
  if (p.kind === 'list.set') state.draft.set(p.index, p.value);
  else if (p.kind === 'list.splice') state.draft.splice(p.index, p.remove, ...(p.insert as unknown[]));
  else throw new Error(`valsem: cannot apply a '${p.kind}' patch to a list draft`);
}

/** current()'s view: virtual edits replayed persistently, or the materialized items rebuilt. */
function snapshotList(state: DraftState<ValueList<unknown>>): unknown {
  const s = state as ListState;
  if (s.items === null) {
    let result = s.base;
    for (const [i, v] of s.vEdits) result = result.set(i, snapshotOf(v));
    for (const v of s.vTail) result = result.push(snapshotOf(v));
    return result;
  }
  return s.from(s.items.map(snapshotOf));
}

function finalizeList(
  state: ListState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const emitting = recorder !== undefined && path !== null;
  const patchMark = emitting ? recorder!.patches.length : 0;
  const opCount = state.ops.length;
  if (emitting) emitSeqOps(state.ops, path!, recorder);

  const assignedIdx = new Set<number>();
  for (const op of state.ops) if (op.t === 'set') assignedIdx.add(op.i);

  if (state.items === null) {
    // Virtual mode: replay point edits and the appended tail onto the base
    // persistently — O(edits · log n), no materialization ever happened.
    let result = state.base;
    for (const [i, v] of state.vEdits) {
      const childPath = emitting && !assignedIdx.has(i) ? [...path!, i] : null;
      result = result.set(i, resolve(v, childPath, recorder));
    }
    for (const v of state.vTail) {
      result = result.push(resolve(v, null, recorder));
    }
    if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
    state.result = result;
    return result;
  }

  const items = state.items;
  const profile = seqTailProfile(state.ops, state.base.length);
  if (profile !== null && profile.finalLen === items.length) {
    // Materialized but positions stable below the low-water mark: replay
    // persistently — sets below `low`, then rebuild the rewritten tail.
    const L = state.base.length;
    const L2 = items.length;
    const low = profile.low;
    let result = state.base;
    const touched = new Set(assignedIdx);
    for (const i of state.drafted) touched.add(i);
    for (const i of touched) {
      if (i >= low) continue;
      const childPath = emitting && !assignedIdx.has(i) ? [...path!, i] : null;
      result = result.set(i, resolve(items[i], childPath, recorder));
    }
    for (let k = low; k < L; k++) result = result.pop();
    for (let i = low; i < L2; i++) result = result.push(resolve(items[i], null, recorder));
    if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
    state.result = result;
    return result;
  }

  // Mid-sequence splices: rebuild from the resolved items.
  const resolved = new Array<unknown>(items.length);
  for (let i = 0; i < items.length; i++) {
    const st = stateOf(items[i]);
    const childPath =
      emitting && st !== undefined && !st.finalized ? [...path!, i] : null;
    resolved[i] = resolve(items[i], childPath, recorder);
  }
  state.result = state.from(resolved);
  if (emitting && state.result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
  return state.result;
}
