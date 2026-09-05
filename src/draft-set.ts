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
} from './draft-core.js';
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
  declare readonly [DRAFT_STATE]: SetState;

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

  forEach(fn: (value: T, value2: T, set: DraftSet<T>) => void, thisArg?: unknown): void {
    for (const v of this.values()) fn.call(thisArg, v, v, this);
  }
}

/** Mutable draft twin of {@link ValueList}, handed out inside produce(). */

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

function finalizeSet(
  state: SetState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  let result = state.cleared ? state.empty() : state.base;
  for (const v of state.removed) result = result.delete(v);
  for (const v of state.added) result = result.add(v);
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
