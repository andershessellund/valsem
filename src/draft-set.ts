// ---------------------------------------------------------------------------
// DraftSet — the mutable draft twin of ValueSet, and its finalize.
//
// ValueSet implements the `[toDraft]` protocol (see draft-core.ts) by calling
// createSetDraft; produce never imports this module. It rides the same
// toolkit any third-party draftable would.
// ---------------------------------------------------------------------------

import { intern } from './intern.js';
import {
  DRAFT_STATE,
  createDraftState,
  markChanged,
  assertUnrevoked,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
  snapshotOf,
  inspectDraft,
} from './draft-core.js';
import { INSPECT, type Inspect, type InspectOptions, findIndexIn, reduceIn } from './shared.js';
import type { ValueSet } from './value-set.js';

const INTERNAL = Symbol('valsem.draftInternal');

export interface SetState<T = unknown> extends DraftState<ValueSet<T>> {
  kind: 'set';
  /** The canonical empty set of this kind (for `clear()`). */
  empty: () => ValueSet<unknown>;
  added: Set<unknown>;
  removed: Set<unknown>;
  cleared: boolean;
  draft: DraftSet<T>;
}

export class DraftSet<T> {
  declare readonly [DRAFT_STATE]: SetState<T>;

  constructor(token: symbol, state: SetState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftSet instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): SetState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }

  get size(): number {
    const s = this.#state;
    return (s.cleared ? 0 : s.base.size - s.removed.size) + s.added.size;
  }

  has(value: T): boolean {
    const s = this.#state;
    const v = intern(value);
    if (s.added.has(v)) return true;
    if (s.removed.has(v) || s.cleared) return false;
    return s.base.has(v);
  }

  add(value: T): this {
    const s = this.#state;
    if (this.has(value)) return this;
    const v = intern(value);
    markChanged(s);
    if (!s.cleared && s.base.has(v)) {
      s.removed.delete(v); // re-added base member
    } else {
      s.added.add(v);
    }
    return this;
  }

  delete(value: T): boolean {
    const s = this.#state;
    if (!this.has(value)) return false;
    const v = intern(value);
    markChanged(s);
    if (!s.added.delete(v)) s.removed.add(v);
    return true;
  }

  clear(): void {
    const s = this.#state;
    if (this.size === 0) return;
    markChanged(s);
    s.cleared = true;
    s.added.clear();
    s.removed.clear();
  }

  *values(): IterableIterator<T> {
    const s = this.#state;
    if (!s.cleared) {
      for (const v of s.base) {
        if (!s.removed.has(v)) yield v as T;
      }
    }
    yield* s.added as Set<T>;
  }

  keys(): IterableIterator<T> {
    return this.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  // The set algebra does not edit: it answers about the VALUE this draft
  // would be right now (its snapshot, `current(draft)`) and gives back
  // values. `d.tags = d.tags.union(more)` keeps a result.

  /** This set as it is right now, with `other`'s members: a `ValueSet`, as `ValueSet.union`. */
  union<U>(other: Iterable<U>): ValueSet<T | U> {
    return (snapshotOf(this) as ValueSet<T>).union(other);
  }
  /** The members also in `other`, as `ValueSet.intersection`. */
  intersection<U>(other: Iterable<U>): ValueSet<T & U> {
    return (snapshotOf(this) as ValueSet<T>).intersection(other);
  }
  /** The members not in `other`, as `ValueSet.difference`. */
  difference<U>(other: Iterable<U>): ValueSet<T> {
    return (snapshotOf(this) as ValueSet<T>).difference(other);
  }
  /** The members in exactly one of the two, as `ValueSet.symmetricDifference`. */
  symmetricDifference<U>(other: Iterable<U>): ValueSet<T | U> {
    return (snapshotOf(this) as ValueSet<T>).symmetricDifference(other);
  }
  /** Whether every member is in `other`, as `ValueSet.isSubsetOf`. */
  isSubsetOf(other: Iterable<unknown>): boolean {
    return (snapshotOf(this) as ValueSet<T>).isSubsetOf(other);
  }
  /** Whether every member of `other` is in this set, as `ValueSet.isSupersetOf`. */
  isSupersetOf(other: Iterable<unknown>): boolean {
    return (snapshotOf(this) as ValueSet<T>).isSupersetOf(other);
  }
  /** Whether no member is in `other`, as `ValueSet.isDisjointFrom`. */
  isDisjointFrom(other: Iterable<unknown>): boolean {
    return (snapshotOf(this) as ValueSet<T>).isDisjointFrom(other);
  }

  /** `[value, value]` pairs, as `Set.prototype.entries` gives them. */
  *entries(): IterableIterator<[T, T]> {
    for (const v of this.values()) yield [v, v];
  }

  // The functional reads, over the set as it is right now. Members are values
  // already; `map` and `filter` give back a `ValueSet`, as the algebra does.

  /** The `ValueSet` of `fn`'s results, as `ValueSet.map`. */
  map<U>(fn: (value: T, value2: T, set: DraftSet<T>) => U, thisArg?: unknown): ValueSet<U> {
    return (snapshotOf(this) as ValueSet<T>).map((v) => fn.call(thisArg, v, v, this));
  }

  /** The `ValueSet` of the members `fn` accepts, as `ValueSet.filter`. */
  filter<S extends T>(fn: (value: T, value2: T, set: DraftSet<T>) => value is S, thisArg?: unknown): ValueSet<S>;
  filter(fn: (value: T, value2: T, set: DraftSet<T>) => unknown, thisArg?: unknown): ValueSet<T>;
  filter(fn: (value: T, value2: T, set: DraftSet<T>) => unknown, thisArg?: unknown): ValueSet<T> {
    return (snapshotOf(this) as ValueSet<T>).filter((v) => fn.call(thisArg, v, v, this));
  }

  /** A fold over the members, from `initial`. */
  reduce<U>(fn: (acc: U, value: T, value2: T, set: DraftSet<T>) => U, initial: U): U {
    return reduceIn(this.values(), this, false, 'DraftSet.reduce', [fn, initial]) as U;
  }

  /** Whether `fn` accepts any member. */
  some(fn: (value: T, value2: T, set: DraftSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.values(), this, false, fn as never, thisArg) !== -1;
  }

  /** Whether `fn` accepts every member. */
  every(fn: (value: T, value2: T, set: DraftSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.values(), this, false, fn as never, thisArg, false) === -1;
  }

  forEach(fn: (value: T, value2: T, set: DraftSet<T>) => void, thisArg?: unknown): void {
    for (const v of this.values()) fn.call(thisArg, v, v, this);
  }

  /**
   * What `JSON.stringify` sees: the JSON of the value this draft would be
   * right now (an array), which is `current(draft).toJSON()`. Through the
   * snapshot and not by iterating the draft: iteration hands out child
   * drafts, and a drafted element of a `[toDraft]` type of your own would
   * stringify as its draft object, not as its value. A look, not an edit.
   */
  toJSON(): T[] {
    return (snapshotOf(this) as ValueSet<T>).toJSON();
  }

  /** What `console.log` shows (Node's `util.inspect`): what the draft holds right now. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectDraft('DraftSet', this, () => this.size, () => new Set(this), depth, options, inspect);
  }
}


/** Draft `base` under `parent`; `empty` builds the canonical empty set for `clear()`. */
export function createSetDraft<T>(
  base: ValueSet<T>,
  parent: DraftState | undefined,
  empty: () => ValueSet<unknown>,
): SetState<T> {
  const state = createDraftState<SetState>({
    kind: 'set',
    parent,
    base: base as ValueSet<unknown>,
    empty,
    added: new Set(),
    removed: new Set(),
    cleared: false,
    draft: null as unknown as DraftSet<unknown>,
    finalize: finalizeSet,
    snapshot: currentSet,
    applyPatch: applySetPatch,
  });
  state.draft = new DraftSet(INTERNAL, state);
  return state as SetState<T>;
}

function applySetPatch(state: SetState, p: Patch): void {
  if (p.kind === 'set.add') state.draft.add(p.value);
  else if (p.kind === 'set.delete') state.draft.delete(p.value);
  else throw new Error(`valsem: cannot apply a '${p.kind}' patch to a set draft`);
}

/** The set as it stands: base (or empty, if cleared) minus removals plus additions. Also current()'s view. */
function currentSet(state: DraftState<ValueSet<unknown>>): ValueSet<unknown> {
  const s = state as SetState;
  let result = s.cleared ? s.empty() : s.base;
  for (const v of s.removed) result = result.delete(v);
  for (const v of s.added) result = result.add(v);
  return result;
}

function finalizeSet(
  state: SetState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const result = currentSet(state);
  state.result = result;

  if (recorder !== undefined && path !== null) {
    const removedAll = state.cleared
      ? [...state.base].filter((v) => !state.added.has(v))
      : [...state.removed];
    for (const v of removedAll) {
      recorder.patches.push({ kind: 'set.delete', path, value: v });
      recorder.inverse.unshift({ kind: 'set.add', path, value: v });
    }
    for (const v of state.added) {
      if (state.cleared && state.base.has(v)) continue;
      recorder.patches.push({ kind: 'set.add', path, value: v });
      recorder.inverse.unshift({ kind: 'set.delete', path, value: v });
    }
  }
  return result;
}
