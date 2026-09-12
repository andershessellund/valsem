// ---------------------------------------------------------------------------
// DraftOrderedSet — the mutable twin of OrderedSet inside produce().
//
// The draft keeps a persistent WORKING set that every operation is applied
// to as it happens (each O(log n)), plus an op log in operation order —
// order is part of the value, so patches replay the operations rather than
// a netted membership delta (delete-then-add moves a member to the end and
// must say so). Finalize is the working set itself.
// ---------------------------------------------------------------------------

import { intern } from './intern.js';
import {
  DRAFT_STATE,
  createDraftState,
  markChanged,
  assertUnrevoked,
  restoreValue,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
} from './draft-core.js';
import type { OrderedSet } from './ordered-set.js';

const INTERNAL = Symbol('valsem.draft-ordered-set');

export type OrderedSetOp =
  | { t: 'add'; value: unknown }
  | { t: 'delete'; value: unknown; index: number }
  | { t: 'insert'; index: number; value: unknown }
  /** The set as it stood — walked only when patches are emitted. */
  | { t: 'clear'; before: OrderedSet<unknown> };

export interface OrderedSetState<T = unknown> extends DraftState<OrderedSet<T>> {
  kind: 'oset';
  /** The canonical empty set (for `clear()`). */
  empty: () => OrderedSet<unknown>;
  /** The set as it stands — every op applied persistently. */
  work: OrderedSet<unknown>;
  ops: OrderedSetOp[];
  draft: DraftOrderedSet<T>;
}

/** Mutable draft twin of {@link OrderedSet}, handed out inside produce(). */
export class DraftOrderedSet<T> implements Iterable<T> {
  declare readonly [DRAFT_STATE]: OrderedSetState<T>;

  constructor(token: symbol, state: OrderedSetState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftOrderedSet instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): OrderedSetState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }

  get size(): number {
    return this.#state.work.size;
  }

  has(value: T): boolean {
    return this.#state.work.has(value);
  }

  indexOf(value: T): number {
    return this.#state.work.indexOf(value);
  }

  at(index: number): T | undefined {
    return this.#state.work.at(index) as T | undefined;
  }

  first(): T | undefined {
    return this.#state.work.first() as T | undefined;
  }

  last(): T | undefined {
    return this.#state.work.last() as T | undefined;
  }

  /** Append `value` (interned on entry); a present member keeps its position. */
  add(value: T): this {
    const s = this.#state;
    const v = intern(value);
    if (s.work.has(v)) return this;
    markChanged(s);
    s.work = s.work.add(v);
    s.ops.push({ t: 'add', value: v });
    return this;
  }

  delete(value: T): boolean {
    const s = this.#state;
    const v = intern(value);
    if (!s.work.has(v)) return false;
    markChanged(s);
    const index = s.work.indexOf(v);
    s.work = s.work.delete(v);
    s.ops.push({ t: 'delete', value: v, index });
    return true;
  }

  /** Insert a new member before `index`; throws if it is already a member. */
  insertAt(index: number, value: T): this {
    const s = this.#state;
    const v = intern(value);
    const next = s.work.insertAt(index, v); // validates the index and membership
    markChanged(s);
    s.work = next;
    s.ops.push({ t: 'insert', index, value: v });
    return this;
  }

  clear(): void {
    const s = this.#state;
    if (s.work.size === 0) return;
    markChanged(s);
    s.ops.push({ t: 'clear', before: s.work });
    s.work = s.empty();
  }

  values(): IterableIterator<T> {
    return this.#state.work.values() as IterableIterator<T>;
  }

  keys(): IterableIterator<T> {
    return this.values();
  }

  entries(): IterableIterator<[T, T]> {
    return this.#state.work.entries() as IterableIterator<[T, T]>;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  forEach(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => void, thisArg?: unknown): void {
    for (const v of this.values()) fn.call(thisArg, v, v, this);
  }
}

/** Draft `base` under `parent`; `empty` builds the canonical empty set for `clear()`. */
export function createOrderedSetDraft<T>(
  base: OrderedSet<T>,
  parent: DraftState | undefined,
  empty: () => OrderedSet<unknown>,
): OrderedSetState<T> {
  const state = createDraftState<OrderedSetState>({
    kind: 'oset',
    parent,
    base: base as OrderedSet<unknown>,
    empty,
    work: base as OrderedSet<unknown>,
    ops: [],
    draft: null as unknown as DraftOrderedSet<unknown>,
    finalize: finalizeOrderedSet,
    snapshot: (state) => (state as OrderedSetState).work,
    applyPatch: applyOrderedSetPatch,
  });
  state.draft = new DraftOrderedSet(INTERNAL, state);
  return state as OrderedSetState<T>;
}

function applyOrderedSetPatch(state: OrderedSetState, p: Patch): void {
  if (p.kind === 'oset.add') state.draft.add(p.value);
  else if (p.kind === 'oset.delete') state.draft.delete(p.value);
  else if (p.kind === 'oset.insert') {
    if (!Number.isInteger(p.index)) throw new Error("valsem: malformed 'oset.insert' patch — expected an integer index");
    state.draft.insertAt(p.index, p.value);
  } else throw new Error(`valsem: cannot apply a '${p.kind}' patch to an ordered set draft`);
}

/** Emit the op log as patches (forward in order; inverses so that they apply in reverse). Returns the inverse count. */
export function emitOrderedSetOps(ops: readonly OrderedSetOp[], path: PatchPath, recorder: PatchRecorder): number {
  let n = 0;
  for (const op of ops) {
    if (op.t === 'add') {
      recorder.patches.push({ kind: 'oset.add', path, value: op.value });
      recorder.inverse.unshift({ kind: 'oset.delete', path, value: op.value });
      n++;
    } else if (op.t === 'delete') {
      recorder.patches.push({ kind: 'oset.delete', path, value: op.value });
      recorder.inverse.unshift({ kind: 'oset.insert', path, index: op.index, value: op.value });
      n++;
    } else if (op.t === 'insert') {
      recorder.patches.push({ kind: 'oset.insert', path, index: op.index, value: op.value });
      recorder.inverse.unshift({ kind: 'oset.delete', path, value: op.value });
      n++;
    } else {
      const values = [...op.before];
      for (let i = 0; i < values.length; i++) {
        recorder.patches.push({ kind: 'oset.delete', path, value: values[i] });
      }
      // Re-adding in the original order restores it; unshift from the end so the inverse run reads a, b, c.
      for (let i = values.length - 1; i >= 0; i--) {
        recorder.inverse.unshift({ kind: 'oset.add', path, value: restoreValue(values[i]) });
      }
      n += values.length;
    }
  }
  return n;
}

function finalizeOrderedSet(state: OrderedSetState, path: PatchPath | null, recorder: PatchRecorder | undefined): unknown {
  const result = state.work;
  state.result = result;
  if (recorder !== undefined && path !== null && result !== state.base) {
    emitOrderedSetOps(state.ops, path, recorder);
  }
  return result;
}
