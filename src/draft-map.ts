// ---------------------------------------------------------------------------
// DraftMap — the mutable draft twin of ValueMap, and its finalize.
//
// ValueMap implements the `[toDraft]` protocol (see draft-core.ts) by calling
// createMapDraft; produce never imports this module. It rides the same
// toolkit any third-party draftable would.
// ---------------------------------------------------------------------------

import { intern } from './intern.js';
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
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
} from './draft-core.js';
import type { ValueMap } from './value-map.js';
import type { Draft } from './produce.js';

const INTERNAL = Symbol('valsem.draftInternal');

export interface MapState<K = unknown, V = unknown> extends DraftState<ValueMap<K, V>> {
  kind: 'map';
  /** The canonical empty map of this kind (for `clear()`). */
  empty: () => ValueMap<unknown, unknown>;
  /** Canonical key → current value (draft or raw). */
  edits: Map<unknown, unknown>;
  /** Canonical key → true (set) | false (deleted); absent = child-drafted only. */
  assigned: Map<unknown, boolean>;
  cleared: boolean;
  draft: DraftMap<K, V>;
}

export class DraftMap<K, V> {
  declare readonly [DRAFT_STATE]: MapState;

  constructor(token: symbol, state: MapState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftMap instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): MapState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }

  get size(): number {
    const s = this.#state;
    let n = s.cleared ? 0 : s.base.size;
    for (const [k, assigned] of s.assigned) {
      const inBase = !s.cleared && s.base.has(k);
      if (assigned && !inBase) n++;
      else if (!assigned && inBase) n--;
    }
    return n;
  }

  has(key: K): boolean {
    const s = this.#state;
    const k = intern(key);
    const assigned = s.assigned.get(k);
    if (assigned !== undefined) return assigned;
    return !s.cleared && s.base.has(k);
  }

  get(key: K): Draft<V> | undefined {
    const s = this.#state;
    const k = intern(key);
    if (s.edits.has(k)) {
      const edited = s.edits.get(k);
      // A frozen assigned value (a canonical placed into the draft) must
      // copy-on-write when read for mutation — same rule as the traps.
      if (
        !s.finalized &&
        isDraftable(edited) &&
        stateOf(edited) === undefined &&
        Object.isFrozen(edited)
      ) {
        const child = createChildDraft(edited, s);
        s.edits.set(k, child); // stays assigned — resolves at finalize
        return child as Draft<V>;
      }
      return edited as Draft<V>;
    }
    if (s.assigned.get(k) === false || s.cleared) return undefined;
    const value = s.base.get(k);
    if (value !== undefined && isDraftable(value) && !s.finalized) {
      const child = createChildDraft(value, s);
      s.edits.set(k, child); // child-drafted — deliberately NOT assigned
      return child as Draft<V>;
    }
    return value as Draft<V> | undefined;
  }

  set(key: K, value: V): this {
    const s = this.#state;
    const k = intern(key);
    if (this.has(key as K)) {
      const current = s.edits.has(k) ? s.edits.get(k) : s.base.get(k);
      if (same(current, value)) return this;
    }
    assertAssignable(value, s);
    markChanged(s);
    s.edits.set(k, value);
    s.assigned.set(k, true);
    return this;
  }

  delete(key: K): boolean {
    const s = this.#state;
    if (!this.has(key)) return false;
    const k = intern(key);
    markChanged(s);
    s.edits.delete(k);
    s.assigned.set(k, false);
    return true;
  }

  clear(): void {
    const s = this.#state;
    if (this.size === 0) return;
    markChanged(s);
    s.cleared = true;
    s.edits.clear();
    s.assigned.clear();
  }

  *entries(): IterableIterator<[K, V]> {
    const s = this.#state;
    if (!s.cleared) {
      for (const [k, v] of s.base) {
        if (s.assigned.get(k) === false || s.edits.has(k)) continue;
        yield [k as K, v as V];
      }
    }
    for (const [k, v] of s.edits) {
      if (s.assigned.get(k) === false) continue;
      yield [k as K, v as V];
    }
  }

  *keys(): IterableIterator<K> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): IterableIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  forEach(fn: (value: V, key: K, map: DraftMap<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
}

/** Mutable draft twin of {@link ValueSet}, handed out inside produce(). */

/** Draft `base` under `parent`; `empty` builds the canonical empty map for `clear()`. */
export function createMapDraft<K, V>(
  base: ValueMap<K, V>,
  parent: DraftState | undefined,
  empty: () => ValueMap<unknown, unknown>,
): MapState<K, V> {
  const state = createDraftState<MapState>({
    kind: 'map',
    parent,
    base: base as ValueMap<unknown, unknown>,
    empty,
    edits: new Map(),
    assigned: new Map(),
    cleared: false,
    draft: null as unknown as DraftMap<unknown, unknown>,
    finalize: finalizeMap,
    applyPatch: applyMapPatch,
    childAt: (state, segment) => (state as MapState).draft.get(segment),
  });
  state.draft = new DraftMap(INTERNAL, state);
  return state as MapState<K, V>;
}

function applyMapPatch(state: MapState, p: Patch): void {
  if (p.kind === 'map.set') state.draft.set(p.key, p.value);
  else if (p.kind === 'map.delete') state.draft.delete(p.key);
  else throw new Error(`valsem: cannot apply a '${p.kind}' patch to a map draft`);
}

function finalizeMap(
  state: MapState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  let result = state.cleared ? state.empty() : state.base;
  const emitting = recorder !== undefined && path !== null;

  if (emitting && state.cleared) {
    for (const [k, v] of state.base) {
      if (state.assigned.get(k) !== undefined) continue; // covered below
      recorder.patches.push({ kind: 'map.delete', path: path!, key: k });
      recorder.inverse.unshift({ kind: 'map.set', path: path!, key: k, value: v });
    }
  }

  for (const [key, wasSet] of state.assigned) {
    const hadBefore = state.base.has(key);
    const before = state.base.get(key);
    if (wasSet) {
      const after = resolve(state.edits.get(key), null, recorder);
      result = result.set(key, after);
      if (emitting) {
        if (hadBefore && !state.cleared && same(before, after)) continue;
        recorder.patches.push({ kind: 'map.set', path: path!, key, value: after });
        recorder.inverse.unshift(
          hadBefore
            ? { kind: 'map.set', path: path!, key, value: before }
            : { kind: 'map.delete', path: path!, key },
        );
      }
    } else {
      result = result.delete(key);
      if (emitting && hadBefore) {
        recorder.patches.push({ kind: 'map.delete', path: path!, key });
        recorder.inverse.unshift({ kind: 'map.set', path: path!, key, value: before });
      }
    }
  }

  // Child-drafted (unassigned) entries: deeper patches at path + key.
  for (const [key, value] of state.edits) {
    if (state.assigned.has(key)) continue;
    const childPath = emitting ? [...path!, key] : null;
    result = result.set(key, resolve(value, childPath, recorder));
  }

  state.result = result;
  return result;
}
