// ---------------------------------------------------------------------------
// DraftOrderedMap — the mutable twin of OrderedMap inside produce().
//
// Order lives in a persistent WORKING map — the base, with every structural
// op applied as it happens (each O(log n); a new key holds a placeholder
// value); values live in an overlay from key to what the recipe sees there
// — its own assignment, or a child draft made on read (the immer rule: a
// frozen canonical is drafted copy-on-write, raw material the recipe just
// made is handed back bare). An op log in operation order feeds the
// patches, because order is part of the value: a DraftMap nets patches by
// content, and would say nothing about a key deleted and set back to the
// same value, which here moved to the end. Finalize is the working map with
// the overlay's resolved values set into it.
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
  snapshotOf,
  isImmutable,
  restoreValue,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
} from './draft-core.js';
import type { OrderedMap } from './ordered-map.js';
import type { Draft } from './produce.js';

const INTERNAL = Symbol('valsem.draft-ordered-map');

interface Entry {
  v: unknown;
  /** true = assigned by the recipe (its own material); false = child-drafted on read. */
  assigned: boolean;
}

export type OrderedMapOp =
  | { t: 'set'; key: unknown; entry: Entry; old: unknown; existed: boolean }
  | { t: 'delete'; key: unknown; index: number; old: unknown }
  | { t: 'insert'; index: number; key: unknown; entry: Entry }
  /** The working map and overlay as they stood — walked only when patches are emitted. */
  | { t: 'clear'; before: OrderedMap<unknown, unknown>; edits: Map<unknown, Entry> };

export interface OrderedMapState<K = unknown, V = unknown> extends DraftState<OrderedMap<K, V>> {
  kind: 'omap';
  /** The canonical empty map (for `clear()`). */
  empty: () => OrderedMap<unknown, unknown>;
  /** The base with every structural op applied persistently — the order and membership; a new key holds `undefined` until finalize. */
  work: OrderedMap<unknown, unknown>;
  /** Canonical key → what the recipe sees there. Absent = the base value, untouched. */
  edits: Map<unknown, Entry>;
  ops: OrderedMapOp[];
  draft: DraftOrderedMap<K, V>;
}

/** Mutable draft twin of {@link OrderedMap}, handed out inside produce(); `get()` returns drafts. */
export class DraftOrderedMap<K, V> {
  declare readonly [DRAFT_STATE]: OrderedMapState<K, V>;

  constructor(token: symbol, state: OrderedMapState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftOrderedMap instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): OrderedMapState {
    const s = this[DRAFT_STATE] as unknown as OrderedMapState;
    assertUnrevoked(s);
    return s;
  }

  /** What the recipe currently sees under a present canonical key `k`. */
  #current(s: OrderedMapState, k: unknown): unknown {
    const e = s.edits.get(k);
    return e !== undefined ? e.v : s.base.get(k);
  }

  get size(): number {
    return this.#state.work.size;
  }

  has(key: K): boolean {
    return this.#state.work.has(intern(key));
  }

  get(key: K): Draft<V> | undefined {
    const s = this.#state;
    const k = intern(key);
    const e = s.edits.get(k);
    if (e !== undefined) {
      // A frozen assigned value (a canonical placed into the draft) must
      // copy-on-write when read for mutation — same rule as the traps.
      if (!s.finalized && isDraftable(e.v) && stateOf(e.v) === undefined && isImmutable(e.v)) {
        e.v = createChildDraft(e.v, s); // stays assigned — resolves at finalize
      }
      return e.v as Draft<V>;
    }
    if (!s.work.has(k)) return undefined;
    const value = s.base.get(k);
    if (value !== undefined && isDraftable(value) && !s.finalized) {
      const child = createChildDraft(value, s);
      s.edits.set(k, { v: child, assigned: false }); // child-drafted — deliberately NOT assigned
      return child as Draft<V>;
    }
    return value as Draft<V> | undefined;
  }

  indexOf(key: K): number {
    return this.#state.work.indexOf(intern(key));
  }

  keyAt(index: number): K | undefined {
    return this.#state.work.keyAt(index) as K | undefined;
  }

  at(index: number): [K, Draft<V>] | undefined {
    const s = this.#state;
    if (index < 0 || index >= s.work.size) return undefined;
    const k = s.work.keyAt(index);
    return [k as K, this.get(k as K) as Draft<V>];
  }

  first(): [K, Draft<V>] | undefined {
    return this.at(0);
  }

  last(): [K, Draft<V>] | undefined {
    return this.at(this.#state.work.size - 1);
  }

  /** Set `key` → `value`: a present key keeps its position, a new key is appended. */
  set(key: K, value: V): this {
    const s = this.#state;
    const k = intern(key);
    const existed = s.work.has(k);
    let old: unknown;
    if (existed) {
      old = this.#current(s, k);
      if (same(old, value)) return this;
    }
    assertAssignable(value, s);
    markChanged(s);
    const entry: Entry = { v: value, assigned: true };
    s.edits.set(k, entry);
    if (!existed) s.work = s.work.set(k, undefined);
    s.ops.push({ t: 'set', key: k, entry, old, existed });
    return this;
  }

  delete(key: K): boolean {
    const s = this.#state;
    const k = intern(key);
    if (!s.work.has(k)) return false;
    markChanged(s);
    const index = s.work.indexOf(k);
    const old = this.#current(s, k);
    s.work = s.work.delete(k);
    s.edits.delete(k);
    s.ops.push({ t: 'delete', key: k, index, old });
    return true;
  }

  /** Insert a new entry before `index`; throws if the key is present. */
  insertAt(index: number, key: K, value: V): this {
    const s = this.#state;
    const k = intern(key);
    if (s.work.has(k)) {
      throw new Error('valsem: OrderedMap.insertAt: the key is already present — delete it first to move it');
    }
    const next = s.work.insertAt(index, k, undefined); // validates the index
    assertAssignable(value, s);
    markChanged(s);
    const entry: Entry = { v: value, assigned: true };
    s.edits.set(k, entry);
    s.work = next;
    s.ops.push({ t: 'insert', index, key: k, entry });
    return this;
  }

  clear(): void {
    const s = this.#state;
    if (s.work.size === 0) return;
    markChanged(s);
    s.ops.push({ t: 'clear', before: s.work, edits: s.edits });
    s.work = s.empty();
    s.edits = new Map();
  }

  *entries(): IterableIterator<[K, V]> {
    const s = this.#state;
    for (const k of s.work.keys()) yield [k as K, this.#current(s, k) as V];
  }

  keys(): IterableIterator<K> {
    return this.#state.work.keys() as IterableIterator<K>;
  }

  *values(): IterableIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  forEach(fn: (value: V, key: K, map: DraftOrderedMap<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
}

/** Draft `base` under `parent`; `empty` builds the canonical empty map for `clear()`. */
export function createOrderedMapDraft<K, V>(
  base: OrderedMap<K, V>,
  parent: DraftState | undefined,
  empty: () => OrderedMap<unknown, unknown>,
): OrderedMapState<K, V> {
  const state = createDraftState<OrderedMapState>({
    kind: 'omap',
    parent,
    base: base as OrderedMap<unknown, unknown>,
    empty,
    work: base as OrderedMap<unknown, unknown>,
    edits: new Map(),
    ops: [],
    draft: null as unknown as DraftOrderedMap<unknown, unknown>,
    finalize: finalizeOrderedMap,
    snapshot: (state) => withEdits(state as OrderedMapState, true, undefined, null),
    applyPatch: applyOrderedMapPatch,
    childAt: (state, segment) => (state as OrderedMapState).draft.get(segment),
  });
  state.draft = new DraftOrderedMap(INTERNAL, state);
  return state as OrderedMapState<K, V>;
}

function applyOrderedMapPatch(state: OrderedMapState, p: Patch): void {
  if (p.kind === 'omap.set') state.draft.set(p.key, p.value);
  else if (p.kind === 'omap.delete') state.draft.delete(p.key);
  else if (p.kind === 'omap.insert') {
    if (!Number.isInteger(p.index)) throw new Error("valsem: malformed 'omap.insert' patch — expected an integer index");
    state.draft.insertAt(p.index, p.key, p.value);
  } else throw new Error(`valsem: cannot apply a '${p.kind}' patch to an ordered map draft`);
}

/**
 * The working map with the overlay's values set into it — the result
 * (values resolved) or, with `snap`, current()'s view (values snapshotted,
 * nothing finalized). Every key in the overlay is in the working map at its
 * final position, so this is O(edits · log n) with no replay. `childPath`
 * gives the patch path for a child-drafted entry, or null when not emitting.
 */
function withEdits(state: OrderedMapState, snap: boolean, recorder: PatchRecorder | undefined, childPath: ((k: unknown) => PatchPath) | null): OrderedMap<unknown, unknown> {
  let result = state.work;
  for (const [k, e] of state.edits) {
    const v = snap ? snapshotOf(e.v) : resolve(e.v, !e.assigned && childPath !== null ? childPath(k) : null, recorder);
    result = result.set(k, v);
  }
  return result;
}

/** Emit the op log as patches; forward in order, inverses so that they apply in reverse. */
function emitOps(state: OrderedMapState, path: PatchPath, recorder: PatchRecorder): void {
  for (const op of state.ops) {
    switch (op.t) {
      case 'set':
        recorder.patches.push({ kind: 'omap.set', path, key: op.key, value: resolve(op.entry.v, null, recorder) });
        recorder.inverse.unshift(
          op.existed
            ? { kind: 'omap.set', path, key: op.key, value: restoreValue(op.old) }
            : { kind: 'omap.delete', path, key: op.key },
        );
        break;
      case 'delete':
        recorder.patches.push({ kind: 'omap.delete', path, key: op.key });
        recorder.inverse.unshift({ kind: 'omap.insert', path, index: op.index, key: op.key, value: restoreValue(op.old) });
        break;
      case 'insert':
        recorder.patches.push({ kind: 'omap.insert', path, index: op.index, key: op.key, value: resolve(op.entry.v, null, recorder) });
        recorder.inverse.unshift({ kind: 'omap.delete', path, key: op.key });
        break;
      case 'clear': {
        // What the recipe saw at the time: the overlay's value where it had one, else the working map's (a base value).
        const keys = [...op.before.keys()];
        const valueOf = (k: unknown): unknown => (op.edits.has(k) ? op.edits.get(k)!.v : op.before.get(k));
        for (let i = 0; i < keys.length; i++) {
          recorder.patches.push({ kind: 'omap.delete', path, key: keys[i] });
        }
        // Setting back in the original order restores it; unshift from the end so the inverse run reads a, b, c.
        for (let i = keys.length - 1; i >= 0; i--) {
          recorder.inverse.unshift({ kind: 'omap.set', path, key: keys[i], value: restoreValue(valueOf(keys[i])) });
        }
        break;
      }
    }
  }
}

function finalizeOrderedMap(state: OrderedMapState, path: PatchPath | null, recorder: PatchRecorder | undefined): unknown {
  const emitting = recorder !== undefined && path !== null;
  const patchMark = emitting ? recorder!.patches.length : 0;
  const inverseMark = emitting ? recorder!.inverse.length : 0;
  // Ops first: a child-drafted entry's deeper patches must follow the structural ones they sit under.
  if (emitting) emitOps(state, path!, recorder!);
  const result = withEdits(state, false, recorder, emitting ? (k) => [...path!, k] : null);
  if (emitting && result === state.base) {
    // The edits netted out: retract this container's patches (a changed child would have changed the result).
    recorder!.patches.length = patchMark;
    recorder!.inverse.splice(0, recorder!.inverse.length - inverseMark);
  }
  state.result = result;
  return result;
}
