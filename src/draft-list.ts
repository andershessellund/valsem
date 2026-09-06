// ---------------------------------------------------------------------------
// DraftList — the mutable twin of ValueList inside produce().
//
// Never materialises. The state keeps a persistent working list (`work`)
// that tracks POSITIONS — every structural op is applied to it at O(log n)
// as it happens, with `undefined` placeholders where new elements went —
// and an overlay from current index to what the recipe actually sees
// there: a child draft (drafted on read), or the caller's own raw
// assignment (which stays raw until finalize, the immer rule). A splice
// re-indexes the overlay, O(edits). Finalize resolves the overlay onto
// `work` — O(k log n) for k touched positions — and the recorded ops become
// `list.set`/`list.splice` patches exactly as for DraftList.
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
  isImmutable,
  emitSeqOps,
  retractSeqPatches,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
  type SeqOp,
} from './draft-core.js';
import type { ValueList } from './value-list.js';
import type { Draft } from './produce.js';

const INTERNAL = Symbol('valsem.draft-list');

interface Entry {
  v: unknown;
  /** true = assigned by the recipe (its own material); false = child-drafted on read. */
  assigned: boolean;
}

export interface ListState<T = unknown> extends DraftState<ValueList<T>> {
  kind: 'list';
  /** Positions and canonical placeholders for everything but the tail. */
  work: ValueList<unknown>;
  /** Current index (below `work.length`) → what the recipe sees there. */
  overlay: Map<number, Entry>;
  /** Pushed values not yet in `work` — flushed as one splice by a structural op, or at finalize. */
  tail: Entry[];
  ops: SeqOp[];
  draft: DraftList<T>;
}

/** Move the tail into `work` (as placeholders) and the overlay — before a splice needs exact positions. */
function flushTail(s: ListState): void {
  if (s.tail.length === 0) return;
  const len = s.work.length;
  s.work = s.work.splice(len, 0, new Array<unknown>(s.tail.length).fill(undefined));
  for (let j = 0; j < s.tail.length; j++) s.overlay.set(len + j, s.tail[j]!);
  s.tail = [];
}

export class DraftList<T> implements Iterable<T> {
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

  get length(): number {
    const s = this.#state;
    return s.work.length + s.tail.length;
  }

  /** The entry at `index` if it is overlaid or in the tail, else undefined (the value is then `work`'s). */
  #entry(s: ListState, index: number): Entry | undefined {
    const wl = s.work.length;
    return index < wl ? s.overlay.get(index) : s.tail[index - wl];
  }

  #read(s: ListState, index: number): unknown {
    const e = this.#entry(s, index);
    return e !== undefined ? e.v : s.work.get(index);
  }

  get(index: number): Draft<T> | undefined {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= s.work.length + s.tail.length) return undefined;
    const e = this.#entry(s, index);
    const value = e !== undefined ? e.v : s.work.get(index);
    if (
      isDraftable(value) &&
      !s.finalized &&
      stateOf(value) === undefined &&
      (e === undefined || isImmutable(value))
    ) {
      const child = createChildDraft(value, s);
      const entry: Entry = { v: child, assigned: e !== undefined && e.assigned };
      if (index < s.work.length) s.overlay.set(index, entry);
      else s.tail[index - s.work.length] = entry;
      return child as Draft<T>;
    }
    return value as Draft<T>;
  }

  set(index: number, value: T): this {
    const s = this.#state;
    const len = s.work.length + s.tail.length;
    if (!Number.isInteger(index) || index < 0 || index >= len) {
      throw new RangeError(`DraftList.set: index ${index} out of range [0, ${len})`);
    }
    const current = this.#read(s, index);
    if (same(current, value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    s.ops.push({ t: 'set', i: index, value, old: current });
    if (index < s.work.length) s.overlay.set(index, { v: value, assigned: true });
    else s.tail[index - s.work.length] = { v: value, assigned: true };
    return this;
  }

  push(...values: T[]): number {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    markChanged(s);
    const len = s.work.length + s.tail.length;
    s.ops.push({ t: 'splice', i: len, rc: 0, inserted: values.slice(), removed: [] });
    for (let j = 0; j < values.length; j++) s.tail.push({ v: values[j], assigned: true });
    return len + values.length;
  }

  pop(): T | undefined {
    const s = this.#state;
    const len = s.work.length + s.tail.length;
    if (len === 0) return undefined;
    markChanged(s);
    const removed = this.#read(s, len - 1);
    s.ops.push({ t: 'splice', i: len - 1, rc: 1, inserted: [], removed: [removed] });
    if (s.tail.length !== 0) s.tail.pop();
    else {
      s.work = s.work.pop();
      s.overlay.delete(len - 1);
    }
    return removed as T;
  }

  splice(start: number, deleteCount?: number, ...values: T[]): T[] {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    flushTail(s);
    const len = s.work.length;
    let at = Math.trunc(start);
    at = at < 0 ? Math.max(len + at, 0) : Math.min(at, len);
    const rc =
      deleteCount === undefined ? len - at : Math.min(Math.max(Math.trunc(deleteCount), 0), len - at);
    markChanged(s);
    const removed: unknown[] = [];
    for (let i = at; i < at + rc; i++) removed.push(this.#read(s, i));
    s.ops.push({ t: 'splice', i: at, rc, inserted: values.slice(), removed: removed.slice() });
    s.work = s.work.splice(at, rc, new Array<unknown>(values.length).fill(undefined));
    // Re-index the overlay around the edit.
    const delta = values.length - rc;
    if (s.overlay.size !== 0) {
      const next = new Map<number, Entry>();
      for (const [i, e] of s.overlay) {
        if (i < at) next.set(i, e);
        else if (i >= at + rc) next.set(i + delta, e);
      }
      s.overlay = next;
    }
    for (let j = 0; j < values.length; j++) s.overlay.set(at + j, { v: values[j], assigned: true });
    return removed as T[];
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const s = this.#state;
    if (s.overlay.size === 0) {
      yield* s.work as Iterable<T>;
    } else {
      let i = 0;
      for (const x of s.work) {
        const e = s.overlay.get(i++);
        yield (e !== undefined ? e.v : x) as T;
      }
    }
    for (const e of s.tail) yield e.v as T;
  }

  toArray(): readonly T[] {
    return [...this];
  }
}

/** Draft `base` under `parent`. */
export function createListDraft<T>(
  base: ValueList<T>,
  parent: DraftState | undefined,
): ListState<T> {
  const state = createDraftState<ListState>({
    kind: 'list',
    parent,
    base: base as ValueList<unknown>,
    work: base as ValueList<unknown>,
    overlay: new Map(),
    tail: [],
    ops: [],
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

function snapshotList(state: DraftState<ValueList<unknown>>): unknown {
  const s = state as ListState;
  const edits: [number, unknown][] = [];
  for (const [i, e] of s.overlay) edits.push([i, snapshotOf(e.v)]);
  const result = s.work.setMany(edits);
  return s.tail.length === 0 ? result : result.splice(result.length, 0, s.tail.map((e) => snapshotOf(e.v)));
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
  const edits: [number, unknown][] = [];
  for (const [i, e] of state.overlay) {
    const childPath = emitting && !e.assigned ? [...path!, i] : null;
    edits.push([i, resolve(e.v, childPath, recorder)]);
  }
  let result = state.work.setMany(edits);
  if (state.tail.length !== 0) {
    const tail = state.tail.map((e) => resolve(e.v, null, recorder));
    result = result.splice(result.length, 0, tail);
  }
  if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
  state.result = result;
  return result;
}
