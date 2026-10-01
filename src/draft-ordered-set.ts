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
  snapshotOf,
  inspectDraft,
} from './draft-core.js';
import { INSPECT, type Inspect, type InspectOptions, atIndex, findIndexIn, reduceIn, newEntryIndex } from './shared.js';
import type { OrderedSet } from './ordered-set.js';
import type { ValueList } from './value-list.js';

const INTERNAL = Symbol('valsem.draft-ordered-set');

export type OrderedSetOp =
  | { t: 'add'; value: unknown }
  | { t: 'delete'; value: unknown; index: number }
  | { t: 'insert'; index: number; value: unknown }
  /** The set as it stood — walked only when patches are emitted. */
  | { t: 'clear'; before: OrderedSet<unknown> };

/**
 * The state behind a {@link DraftOrderedSet}. Its bookkeeping is not API: the
 * fields below the two the protocol needs (`kind`, `draft`) are tagged
 * internal, out of the published declarations, free to change in any release.
 */
export interface OrderedSetState<T = unknown> extends DraftState<OrderedSet<T>> {
  kind: 'oset';
  /** @internal The canonical empty set (for `clear()`). */
  empty: () => OrderedSet<unknown>;
  /** @internal The set as it stands — every op applied persistently. */
  work: OrderedSet<unknown>;
  /** @internal */
  ops: OrderedSetOp[];
  draft: DraftOrderedSet<T>;
}

/**
 * Mutable draft twin of {@link OrderedSet}, handed out inside produce(). The
 * verbs (`add`, `delete`, `insertAt`, `clear`) edit in place, and the value's
 * copying edits (`added`, `deleted`, `insertedAt`) are what-ifs; every edit
 * is applied to the working set as it happens, so a what-if here costs one
 * persistent operation, not a fold of pending edits.
 */
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

  /** The members in order, as the canonical `ValueList` of the set this draft would be right now (its snapshot). */
  get valueList(): ValueList<T> {
    return (snapshotOf(this) as OrderedSet<T>).valueList;
  }

  /** The member at `index` as `Array.prototype.at` reads it: a negative index counts from the end, and one that names nothing gives `undefined`. */
  at(index: number): T | undefined {
    const s = this.#state;
    const i = atIndex(index, s.work.size, 'DraftOrderedSet.at'); // checked in this draft's name
    return i === -1 ? undefined : (s.work.at(i) as T);
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
    s.work = s.work.added(v);
    s.ops.push({ t: 'add', value: v });
    return this;
  }

  delete(value: T): boolean {
    const s = this.#state;
    const v = intern(value);
    if (!s.work.has(v)) return false;
    markChanged(s);
    const index = s.work.indexOf(v);
    s.work = s.work.deleted(v);
    s.ops.push({ t: 'delete', value: v, index });
    return true;
  }

  /** Insert a new member before `index` (0 ≤ index ≤ size); throws if it is already a member — a member has one position; delete it first to move it. */
  insertAt(index: number, value: T): this {
    const s = this.#state;
    const v = intern(value);
    newEntryIndex(index, s.work.size, () => s.work.has(v), 'DraftOrderedSet.insertAt', 'member', 'delete');
    const next = s.work.insertedAt(index, v);
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

  // The value's copying edits are what-ifs here: the `OrderedSet` the edit
  // would give, from the set as it is right now, and nothing edited (D59).
  // `add`, `delete` and `insertAt` are the edits.

  /** The set as it is right now with `value` appended (a present member stays put): an `OrderedSet`, as `OrderedSet.added`. To edit, `add`. */
  added(value: T): OrderedSet<T> {
    return (snapshotOf(this) as OrderedSet<T>).added(value);
  }

  /** The set as it is right now without a structurally equal `value`: an `OrderedSet`, as `OrderedSet.deleted`. To edit, `delete`. */
  deleted(value: T): OrderedSet<T> {
    return (snapshotOf(this) as OrderedSet<T>).deleted(value);
  }

  /** The set as it is right now with a new member before `index`: an `OrderedSet`, as `OrderedSet.insertedAt`, with `insertAt`'s checks. To edit, `insertAt`. */
  insertedAt(index: number, value: T): OrderedSet<T> {
    const s = this.#state;
    const v = intern(value);
    newEntryIndex(index, s.work.size, () => s.work.has(v), 'DraftOrderedSet.insertedAt', 'member', 'delete');
    return (snapshotOf(this) as OrderedSet<T>).insertedAt(index, v as T);
  }

  /**
   * The members in order, as the set stood when the walk began — the working
   * set is persistent — except that a member deleted before the walk reaches
   * it is not visited, as on a native `Set` (asked of the current set only
   * once something changed). An iterator outlives nothing: once the recipe
   * has ended, its next step throws, as every other use of the draft does.
   */
  *values(): IterableIterator<T> {
    const s = this.#state;
    const begun = s.work;
    for (const v of begun) {
      assertUnrevoked(s);
      if (s.work !== begun && !s.work.has(v)) continue; // deleted since
      yield v as T;
    }
  }

  keys(): IterableIterator<T> {
    return this.values();
  }

  *entries(): IterableIterator<[T, T]> {
    for (const v of this.values()) yield [v, v];
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  /** What `console.log` shows (Node's `util.inspect`): what the draft holds right now. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectDraft('DraftOrderedSet', this, () => this.size, () => new Set(this), depth, options, inspect);
  }

  // The functional reads, over the set as it is right now. Members are values
  // already; `map` and `filter` give back a `OrderedSet`, as the algebra does.

  /** The `OrderedSet` of `fn`'s results, as `OrderedSet.map`. */
  map<U>(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => U, thisArg?: unknown): OrderedSet<U> {
    return (snapshotOf(this) as OrderedSet<T>).map((v) => fn.call(thisArg, v, v, this));
  }

  /** The `OrderedSet` of the members `fn` accepts, as `OrderedSet.filter`. */
  filter<S extends T>(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => value is S, thisArg?: unknown): OrderedSet<S>;
  filter(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => unknown, thisArg?: unknown): OrderedSet<T>;
  filter(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => unknown, thisArg?: unknown): OrderedSet<T> {
    return (snapshotOf(this) as OrderedSet<T>).filter((v) => fn.call(thisArg, v, v, this));
  }

  /** A fold over the members, in order. With no initial value the first member starts it, and an empty set is a `TypeError`, as on `Array`. */
  reduce(fn: (acc: T, value: T, value2: T, set: DraftOrderedSet<T>) => T): T;
  reduce<U>(fn: (acc: U, value: T, value2: T, set: DraftOrderedSet<T>) => U, initial: U): U;
  reduce(...args: unknown[]): unknown {
    return reduceIn(this.values(), this, false, 'DraftOrderedSet.reduce', args);
  }

  /** Whether `fn` accepts any member. */
  some(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.values(), this, false, fn as never, thisArg) !== -1;
  }

  /** Whether `fn` accepts every member. */
  every(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.values(), this, false, fn as never, thisArg, false) === -1;
  }

  forEach(fn: (value: T, value2: T, set: DraftOrderedSet<T>) => void, thisArg?: unknown): void {
    for (const v of this.values()) fn.call(thisArg, v, v, this);
  }

  /**
   * What `JSON.stringify` sees: the JSON of the value this draft would be
   * right now (an array, in order), which is `current(draft).toJSON()`. Through the
   * snapshot and not by iterating the draft: iteration hands out child
   * drafts, and a drafted element of a `[toDraft]` type of your own would
   * stringify as its draft object, not as its value. A look, not an edit.
   */
  toJSON(): T[] {
    return (snapshotOf(this) as OrderedSet<T>).toJSON();
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
