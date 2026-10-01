// ---------------------------------------------------------------------------
// DraftMap — the mutable draft twin of ValueMap, and its finalize.
//
// The base's membership lives in a persistent WORKING map — the base, with
// every delete applied as it happens (each O(log n)); values, and the keys
// the recipe added, live in an overlay from key to what the recipe sees
// there — its own assignment, or a child draft made on read (the immer
// rule: a frozen canonical is drafted copy-on-write, raw material the recipe
// just made is handed back bare). A new key is not written into the working
// map: order is not part of this value, so nothing needs its position, and
// a placeholder would be a path copy paid twice (measured: sets of new keys
// +60 %). Finalize is the working map with the overlay's resolved values set
// into it, and the patches are the trie diff of base and result: a key
// deleted and set back to its value is no change, and shared subtrees are
// skipped by pointer. DraftOrderedMap's shape, less the placeholder and the
// op log.
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
  snapshotOf,
  isImmutable,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
  inspectDraft,
} from './draft-core.js';
import { INSPECT, type Inspect, type InspectOptions } from './shared.js';
import type { ValueMap } from './value-map.js';
import type { Draft } from './produce.js';

const INTERNAL = Symbol('valsem.draftInternal');

interface Entry {
  v: unknown;
  /** true = assigned by the recipe (its own material); false = child-drafted on read. */
  assigned: boolean;
}

/** What finalize's patches are made of: the entries only in `a`, only in `b`, and changed between them, to visitors (the map class's diff, passed in so that this module needs no value import of it). */
export type MapDiff = (
  a: ValueMap<unknown, unknown>,
  b: ValueMap<unknown, unknown>,
  onlyA: (key: unknown, value: unknown) => void,
  onlyB: (key: unknown, value: unknown) => void,
  changed: (key: unknown, before: unknown, after: unknown) => void,
) => void;

/**
 * The state behind a {@link DraftMap}. Its bookkeeping is not API: the
 * fields below the two the protocol needs (`kind`, `draft`) are tagged
 * internal, out of the published declarations, free to change in any release.
 */
export interface MapState<K = unknown, V = unknown> extends DraftState<ValueMap<K, V>> {
  kind: 'map';
  /** @internal The canonical empty map of this kind (for `clear()`). */
  empty: () => ValueMap<unknown, unknown>;
  /** @internal */
  diff: MapDiff;
  /** @internal The base with every delete applied persistently: which of the base's keys are still present. */
  work: ValueMap<unknown, unknown>;
  /** @internal Canonical key → what the recipe sees there: a present base key's value, or a key the recipe added. Absent = a base value, untouched. */
  edits: Map<unknown, Entry>;
  /** @internal Keys in `edits` that are not in `work`: what the recipe added, counted so that `size` is O(1). */
  added: number;
  draft: DraftMap<K, V>;
}

/**
 * Mutable draft twin of {@link ValueMap}, handed out inside produce(); `get()`
 * returns drafts. The verbs (`set`, `delete`, `clear`) edit in place, and the
 * value's copying edits (`with`, `deleted`) are what-ifs, each built from a
 * snapshot of the pending edits, O(k log n) for k of them; in a loop,
 * `current(d.map)` once.
 */
export class DraftMap<K, V> {
  declare readonly [DRAFT_STATE]: MapState<K, V>;

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

  /** What the recipe currently sees under a present canonical key `k`. */
  #current(s: MapState, k: unknown): unknown {
    const e = s.edits.get(k);
    return e !== undefined ? e.v : s.base.get(k);
  }

  get size(): number {
    const s = this.#state;
    return s.work.size + s.added;
  }

  has(key: K): boolean {
    const s = this.#state;
    const k = intern(key);
    return s.work.has(k) || s.edits.has(k);
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
    // Not in the overlay: a base key still present holds its base value in the working map (one lookup), or it is absent.
    const value = s.work.get(k);
    if (value !== undefined && isDraftable(value) && !s.finalized) {
      const child = createChildDraft(value, s);
      s.edits.set(k, { v: child, assigned: false }); // child-drafted — deliberately NOT assigned
      return child as Draft<V>;
    }
    return value as Draft<V> | undefined;
  }

  set(key: K, value: V): this {
    const s = this.#state;
    const k = intern(key);
    const inBase = s.work.has(k);
    const e = s.edits.get(k);
    if ((inBase || e !== undefined) && same(this.#current(s, k), value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    if (e !== undefined) {
      e.v = value;
      e.assigned = true;
    } else {
      s.edits.set(k, { v: value, assigned: true });
      if (!inBase) s.added++;
    }
    return this;
  }

  delete(key: K): boolean {
    const s = this.#state;
    const k = intern(key);
    if (s.work.has(k)) {
      markChanged(s);
      s.work = s.work.deleted(k);
      s.edits.delete(k);
      return true;
    }
    if (!s.edits.has(k)) return false;
    markChanged(s);
    s.edits.delete(k);
    s.added--;
    return true;
  }

  clear(): void {
    const s = this.#state;
    if (this.size === 0) return;
    markChanged(s);
    s.work = s.empty();
    s.edits.clear(); // in place: a walk over the added keys holds this map's iterator, and must see the clear and what is set after it
    s.added = 0;
  }

  // The value's copying edits are what-ifs here: the `ValueMap` the edit
  // would give, from the map as it is right now, and nothing edited (D59).
  // `set` and `delete` are the edits.

  /** The map as it is right now with `key` → `value`: a `ValueMap`, as `ValueMap.with`. To edit, `set`. */
  with(key: K, value: V): ValueMap<K, V> {
    return (snapshotOf(this) as ValueMap<K, V>).with(key, value);
  }

  /** The map as it is right now without a structurally equal `key`: a `ValueMap`, as `ValueMap.deleted`. To edit, `delete`. */
  deleted(key: K): ValueMap<K, V> {
    return (snapshotOf(this) as ValueMap<K, V>).deleted(key);
  }

  /**
   * The entries, each value drafted if it can be, as `get` hands it out:
   * `for (const [, v] of d.m) v.done = true` edits. The base's entries come
   * first, in the base's order, then the keys the recipe added. A walk that
   * only reads is cheaper over `current(d.m)`, which drafts nothing.
   */
  *entries(): IterableIterator<[K, Draft<V> | (V & undefined)]> {
    for (const k of this.keys()) yield [k, this.get(k) as Draft<V> | (V & undefined)];
  }

  /**
   * The base's keys that are still present, in the base's order, then the keys
   * the recipe added. Live, as a native `Map`'s walk is: an entry deleted
   * before the walk reaches it is not visited (the working map is persistent,
   * so the walk is over the one the walk began with, and asks the current one
   * — only once something changed), and a key added during the walk is (the
   * overlay is a native `Map`, and `get` adds child-drafted base entries to it
   * as the walk goes: the keys the working map lacks are the added ones).
   */
  *keys(): IterableIterator<K> {
    const s = this.#state;
    const begun = s.work;
    for (const k of begun.keys()) {
      assertUnrevoked(s); // an iterator outlives nothing: once the recipe has ended, its next step throws
      if (s.work !== begun && !s.work.has(k)) continue; // deleted since
      yield k as K;
    }
    for (const k of s.edits.keys()) {
      assertUnrevoked(s);
      if (!s.work.has(k)) yield k as K;
    }
  }

  *values(): IterableIterator<Draft<V> | (V & undefined)> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[K, Draft<V> | (V & undefined)]> {
    return this.entries();
  }

  /** The entries as they are held, nothing drafted: what inspection walks. */
  *#peek(): IterableIterator<[K, V]> {
    const s = this.#state;
    for (const k of this.keys()) yield [k, this.#current(s, k) as V];
  }

  /** What `console.log` shows (Node's `util.inspect`): what the draft holds right now. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectDraft('DraftMap', this, () => this.size, () => new Map(this.#peek()), depth, options, inspect);
  }

  forEach(fn: (value: Draft<V> | (V & undefined), key: K, map: DraftMap<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }

  /**
   * What `JSON.stringify` sees: the JSON of the value this draft would be
   * right now (`[key, value]` pairs), which is `current(draft).toJSON()`. Through the
   * snapshot and not by iterating the draft: iteration hands out child
   * drafts, and a drafted element of a `[toDraft]` type of your own would
   * stringify as its draft object, not as its value. A look, not an edit.
   */
  toJSON(): [K, V][] {
    return (snapshotOf(this) as ValueMap<K, V>).toJSON();
  }
}


/** Draft `base` under `parent`; `empty` builds the canonical empty map for `clear()`. */
export function createMapDraft<K, V>(
  base: ValueMap<K, V>,
  parent: DraftState | undefined,
  empty: () => ValueMap<unknown, unknown>,
  diff: MapDiff,
): MapState<K, V> {
  const state = createDraftState<MapState>({
    kind: 'map',
    parent,
    base: base as ValueMap<unknown, unknown>,
    empty,
    diff,
    work: base as ValueMap<unknown, unknown>,
    edits: new Map(),
    added: 0,
    draft: null as unknown as DraftMap<unknown, unknown>,
    finalize: finalizeMap,
    snapshot: (state) => withEdits(state as MapState, true, undefined, null),
    applyPatch: applyMapPatch,
    childAt: (state, segment) => (state as MapState).draft.get(segment),
    replaceChild: (state, segment, value) => void (state as MapState).draft.set(segment, value),
  });
  state.draft = new DraftMap(INTERNAL, state);
  return state as MapState<K, V>;
}

function applyMapPatch(state: MapState, p: Patch): void {
  if (p.kind === 'map.set') state.draft.set(p.key, p.value);
  else if (p.kind === 'map.delete') state.draft.delete(p.key);
  else throw new Error(`valsem: cannot apply a '${p.kind}' patch to a map draft`);
}

/**
 * The working map with the overlay's values set into it — the result
 * (values resolved) or, with `snap`, current()'s view (values snapshotted,
 * nothing finalized). O(edits · log n), with no replay. `childPath` gives the patch path for a
 * child-drafted entry, or null when not emitting.
 */
function withEdits(state: MapState, snap: boolean, recorder: PatchRecorder | undefined, childPath: ((k: unknown) => PatchPath) | null): ValueMap<unknown, unknown> {
  let result = state.work;
  for (const [k, e] of state.edits) {
    const v = snap ? snapshotOf(e.v) : resolve(e.v, !e.assigned && childPath !== null ? childPath(k) : null, recorder);
    result = result.with(k, v);
  }
  return result;
}

function finalizeMap(state: MapState, path: PatchPath | null, recorder: PatchRecorder | undefined): unknown {
  const emitting = recorder !== undefined && path !== null;
  // Child-drafted entries emit their deeper patches here, under path + key.
  const result = withEdits(state, false, recorder, emitting ? (k) => [...path!, k] : null);
  if (emitting && result !== state.base) {
    // The net change by content, from the diff of base and result: a key set
    // back to its base value is no change, and a child-drafted entry's change
    // was told deeper — the diff says nothing of it here.
    state.diff(
      state.base,
      result,
      (key, before) => {
        recorder.patches.push({ kind: 'map.delete', path, key });
        recorder.inverse.unshift({ kind: 'map.set', path, key, value: before });
      },
      (key, after) => {
        recorder.patches.push({ kind: 'map.set', path, key, value: after });
        recorder.inverse.unshift({ kind: 'map.delete', path, key });
      },
      (key, before, after) => {
        if (state.edits.get(key)?.assigned === false) return;
        recorder.patches.push({ kind: 'map.set', path, key, value: after });
        recorder.inverse.unshift({ kind: 'map.set', path, key, value: before });
      },
    );
  }
  state.result = result;
  return result;
}
