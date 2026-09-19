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
  inspectDraft,
} from './draft-core.js';
import type { ValueList } from './value-list.js';
import type { Draft } from './produce.js';
import { extentArg, elementIndex, insertionIndex, INSPECT, type Inspect, type InspectOptions } from './shared.js';

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

  /**
   * The element at `index` (drafted, if it can be), which must name one: an
   * integer in `[0, length)`, or a `RangeError`.
   *
   * The return type is `Draft<T>`, spelled so that TypeScript can still see
   * the class as covariant: `T & undefined` is `never` unless the list holds
   * `undefined` elements, where `Draft<T>` includes it already. A bare
   * conditional type here is opaque to the variance check, and
   * `ValueList<number>` stopped being a `ValueList<unknown>`.
   */
  get(index: number): Draft<T> | (T & undefined) {
    const s = this.#state;
    elementIndex(index, s.work.length + s.tail.length, 'DraftList.get');
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
    elementIndex(index, len, 'DraftList.set');
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
    // As ValueList.splice: the start is a place in the list, the count means
    // "up to". Checked before anything moves.
    const len = s.work.length + s.tail.length;
    const at = insertionIndex(start, len, 'DraftList.splice', 'start');
    const rc = deleteCount === undefined ? len - at : Math.min(extentArg(deleteCount, 'DraftList.splice', 'deleteCount'), len - at);
    flushTail(s);
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

  /** Insert `value` before `index`, an integer in `[0, length]` (else a `RangeError`), as `ValueList.insert`. */
  insert(index: number, value: T): this {
    const s = this.#state;
    this.splice(insertionIndex(index, s.work.length + s.tail.length, 'DraftList.insert'), 0, value);
    return this;
  }

  /** Remove the element at `index`, which must name one: an integer in `[0, length)` (else a `RangeError`). Returns it. */
  remove(index: number): T {
    const s = this.#state;
    return this.splice(elementIndex(index, s.work.length + s.tail.length, 'DraftList.remove'), 1)[0] as T;
  }

  /** Remove and return the first element, `undefined` when empty, as `Array.prototype.shift`. */
  shift(): T | undefined {
    return this.length === 0 ? undefined : this.splice(0, 1)[0];
  }

  /** Insert `values` at the front; the new length, as `Array.prototype.unshift`. */
  unshift(...values: T[]): number {
    this.splice(0, 0, ...values);
    return this.length;
  }

  /**
   * Set many elements at once: `[index, value]` pairs, the last write to an
   * index winning, as `ValueList.setMany`. Every index is checked before
   * anything is written, so a bad one leaves the draft untouched.
   */
  setMany(edits: readonly (readonly [number, T])[]): this {
    const s = this.#state;
    const len = s.work.length + s.tail.length;
    for (const [i] of edits) elementIndex(i, len, 'DraftList.setMany');
    for (const [i, v] of edits) this.set(i, v);
    return this;
  }

  // What does not edit answers about the VALUE this draft would be right now
  // (its snapshot, `current(draft)`), and gives back values, not drafts: only
  // `get` hands out a draft. Assign the result into a slot to keep it.

  /** Elements `[start, end)` of the list as it is right now, as `ValueList.slice`: a value, not a draft. */
  slice(start?: number, end?: number): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).slice(start, end);
  }

  /** The list as it is right now, followed by `other`, as `ValueList.concat`: a value, not a draft. */
  concat(other: ValueList<T>): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).concat(other);
  }

  /** Visit every element in index order, as it is right now (iteration's view: a child already drafted comes as its draft). */
  forEach(fn: (value: T, index: number, list: DraftList<T>) => void, thisArg?: unknown): void {
    let i = 0;
    for (const v of this) fn.call(thisArg, v, i++, this);
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

  /**
   * What `JSON.stringify` sees: the JSON of the value this draft would be
   * right now (an array), which is `current(draft).toJSON()`. Through the
   * snapshot and not by iterating the draft: iteration hands out child
   * drafts, and a drafted element of a `[toDraft]` type of your own would
   * stringify as its draft object, not as its value. A look, not an edit.
   */
  toJSON(): T[] {
    return (snapshotOf(this) as ValueList<T>).toJSON();
  }

  /** What `console.log` shows (Node's `util.inspect`): what the draft holds right now. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectDraft('DraftList', this, () => this.length, () => [...this], depth, options, inspect);
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
    // A path segment comes from a patch, which may come from anywhere: one
    // that names no element is a bad path (the walker's error), not a read.
    childAt: (state, segment) => {
      const s = state as ListState;
      const ok = Number.isInteger(segment) && (segment as number) >= 0 && (segment as number) < s.work.length + s.tail.length;
      return ok ? s.draft.get(segment as number) : undefined;
    },
    replaceChild: (state, segment, value) => void (state as ListState).draft.set(segment as number, value),
  });
  state.draft = new DraftList(INTERNAL, state);
  return state as ListState<T>;
}

function applyListPatch(state: ListState, p: Patch): void {
  if (p.kind === 'list.set') state.draft.set(p.index, p.value);
  else if (p.kind === 'list.splice') {
    // A patch is an exact recorded edit, never "up to": a count that does not
    // fit means it was made against another list, and clamping it would apply
    // it "successfully" to the wrong base.
    const len = state.draft.length;
    if (
      !Number.isInteger(p.index) || p.index < 0 || p.index > len ||
      !Number.isInteger(p.remove) || p.remove < 0 || p.index + p.remove > len ||
      !Array.isArray(p.insert)
    ) {
      throw new Error(
        `valsem: a 'list.splice' patch (index ${String(p.index)}, remove ${String(p.remove)}) does not fit the list it is applied to (length ${len})`,
      );
    }
    state.draft.splice(p.index, p.remove, ...(p.insert as unknown[]));
  }
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
  // An assigned slot is described by the ops above — unless it holds a child
  // draft of THIS list: the op captured the value as assigned, and `get` then
  // drafted it (`l.set(0, c); l.get(0).y = 2`), so the edits are in no op.
  // The child says them itself, after the ops: its own patches, or a
  // `replace` if an alias finalized it first (see `resolve`).
  const slotPath = (e: Entry, i: number): PatchPath | null => {
    if (!emitting) return null;
    if (!e.assigned) return [...path!, i];
    return stateOf(e.v)?.parent === state ? [...path!, i] : null;
  };
  for (const [i, e] of state.overlay) edits.push([i, resolve(e.v, slotPath(e, i), recorder)]);
  let result = state.work.setMany(edits);
  if (state.tail.length !== 0) {
    const at = state.work.length;
    const tail = state.tail.map((e, j) => resolve(e.v, slotPath(e, at + j), recorder));
    result = result.splice(result.length, 0, tail);
  }
  if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
  state.result = result;
  return result;
}
