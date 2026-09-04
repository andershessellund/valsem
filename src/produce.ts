// ---------------------------------------------------------------------------
// produce — mutate a draft, receive the canonical value.
//
//     const next = produce(state, draft => { draft.count++; });
//     next === intern({ ...state, count: state.count + 1 });   // canonical
//
// Architecture (measured against the immer and mutative sources — see
// DESIGN.md §7 and the decision log):
//
// * **Drafts are lazy copy-on-write.** Plain objects and arrays get revocable
//   Proxies created on read, a shallow copy plus assignment bookkeeping on
//   first write, and `modified` bubbling to the root — the immer/mutative
//   skeleton. Value collections get hand-written draft classes (DraftMap /
//   DraftSet / DraftList): no proxies needed, and their method-based APIs let
//   patches record *intent* (real splices) instead of reconstructing it.
//
// * **Finalize is an intern walk.** immer and mutative spend their
//   cleverness avoiding a finalize walk over the changed region; interning
//   must walk it anyway (every changed node is hashed and pooled), so draft
//   replacement, graft adoption, and patch emission all ride the walk we
//   were doing regardless. Bottom-up consing falls out of the recursion;
//   aliased drafts are memoized per state, so every location receives the
//   same canonical instance.
//
// * **The cost law**: finalize work ∝ drafted spine + grafted foreign
//   material. Canonical subtrees are recognized in O(1) via pool markers —
//   NOT `isFrozen`, which would wrongly prune frozen-but-foreign data.
//
// * **The degenerate law**: produce(base, () => {}) === intern(base). And
//   because the result is interned, edits that net out structurally converge
//   back to the canonical base for free.
//
// Patches are net-per-container (deduped through assignment maps, as in both
// libraries) except sequences, where recorded ops preserve splice intent;
// plain arrays intercept the mutating methods to capture the same intent and
// fall back to index diffing when an uncapturable mutation occurs
// (sort/reverse/fill/copyWithin, length writes, sparse growth).
// applyPatches is implemented ON TOP of produce.
// ---------------------------------------------------------------------------

import { intern, _hashCacheHas } from './intern.js';
import { interned as internedMarker } from './deep-equal.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';

/** Recipe return sentinel: "the result is `undefined`" (distinct from returning nothing). */
export const nothing: unique symbol = Symbol('valsem.nothing');

const DRAFT_STATE = Symbol('valsem.draftState');
const INTERNAL = Symbol('valsem.draftInternal');

// ---------------------------------------------------------------------------
// Patch vocabulary
// ---------------------------------------------------------------------------

/**
 * Path from the root to the container a patch operates on. Segments are
 * record keys (string), sequence indices (number), or — under a map — the
 * canonical key value itself.
 */
export type PatchPath = readonly unknown[];

export type Patch =
  | { kind: 'replace'; path: PatchPath; value: unknown }
  | { kind: 'record.set'; path: PatchPath; key: string; value: unknown }
  | { kind: 'record.delete'; path: PatchPath; key: string }
  | { kind: 'list.set'; path: PatchPath; index: number; value: unknown }
  | {
      kind: 'list.splice';
      path: PatchPath;
      index: number;
      remove: number;
      insert: readonly unknown[];
    }
  | { kind: 'map.set'; path: PatchPath; key: unknown; value: unknown }
  | { kind: 'map.delete'; path: PatchPath; key: unknown }
  | { kind: 'set.add'; path: PatchPath; value: unknown }
  | { kind: 'set.delete'; path: PatchPath; value: unknown };

interface PatchRecorder {
  patches: Patch[];
  inverse: Patch[];
}

// ---------------------------------------------------------------------------
// Scope and draft states
// ---------------------------------------------------------------------------

interface Scope {
  parent: Scope | undefined;
  states: AnyState[];
}

let currentScope: Scope | undefined;

interface BaseState {
  scope: Scope;
  parent: AnyState | undefined;
  modified: boolean;
  /** Memoized finalize result — aliased drafts converge on one canonical. */
  result: unknown;
  finalized: boolean;
  revoked: boolean;
}

/** Recorded sequence ops: positions from the log, operand refs captured live. */
type SeqOp =
  | { t: 'set'; i: number; value: unknown; old: unknown }
  | { t: 'splice'; i: number; rc: number; inserted: unknown[]; removed: unknown[] };

interface ObjectState extends BaseState {
  type: 'object';
  base: Record<string, unknown>;
  copy: Record<string, unknown> | null;
  /** true = set, false = deleted; absent key = only child-drafted. */
  assigned: Map<string, boolean> | null;
  draft: object;
  revoke: () => void;
}

interface ArrayState extends BaseState {
  type: 'array';
  base: unknown[];
  copy: unknown[] | null;
  /** Recorded ops (intent); null once an uncapturable mutation occurred. */
  ops: SeqOp[] | null;
  draft: unknown[];
  revoke: () => void;
}

interface MapState extends BaseState {
  type: 'map';
  base: ValueMap<unknown, unknown>;
  /** Canonical key → current value (draft or raw). */
  edits: Map<unknown, unknown>;
  /** Canonical key → true (set) | false (deleted); absent = child-drafted only. */
  assigned: Map<unknown, boolean>;
  cleared: boolean;
  draft: DraftMap<unknown, unknown>;
}

interface SetState extends BaseState {
  type: 'set';
  base: ValueSet<unknown>;
  added: Set<unknown>;
  removed: Set<unknown>;
  cleared: boolean;
  draft: DraftSet<unknown>;
}

interface ListState extends BaseState {
  type: 'list';
  base: ValueList<unknown>;
  /** Materialized working array (created on first write / child draft). */
  items: unknown[] | null;
  ops: SeqOp[] | null;
  draft: DraftList<unknown>;
}

type AnyState = ObjectState | ArrayState | MapState | SetState | ListState;

function stateOf(value: unknown): AnyState | undefined {
  return value !== null && typeof value === 'object'
    ? ((value as Record<symbol, unknown>)[DRAFT_STATE] as AnyState | undefined)
    : undefined;
}

/** Whether `value` is a valsem draft (proxy or collection draft). */
export function isDraft(value: unknown): boolean {
  return stateOf(value) !== undefined;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** SameValueZero. */
function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Values produce hands out as drafts. */
function isDraftable(v: unknown): boolean {
  return (
    isPlainObject(v) ||
    Array.isArray(v) ||
    v instanceof ValueMap ||
    v instanceof ValueSet ||
    v instanceof ValueList
  );
}

function markChanged(state: AnyState): void {
  if (!state.modified) {
    state.modified = true;
    if (state.parent) markChanged(state.parent);
  }
}

function assertUnrevoked(state: AnyState): void {
  if (state.revoked) {
    throw new Error(
      'valsem: this draft escaped its produce() call and can no longer be used. ' +
        'Drafts are only valid inside the recipe.',
    );
  }
}

function assertAssignable(value: unknown, into: AnyState): void {
  const vState = stateOf(value);
  if (vState !== undefined && vState.scope !== into.scope) {
    throw new Error('valsem: cannot assign a draft from a different produce() call.');
  }
}

function createChildDraft(value: unknown, parent: AnyState): unknown {
  if (isPlainObject(value)) return createObjectDraft(value, parent).draft;
  if (Array.isArray(value)) return createArrayDraft(value, parent).draft;
  if (value instanceof ValueMap) return createMapDraft(value, parent).draft;
  if (value instanceof ValueSet) return createSetDraft(value, parent).draft;
  return createListDraft(value as ValueList<unknown>, parent).draft;
}

// ---------------------------------------------------------------------------
// Plain-object drafts (Proxy)
// ---------------------------------------------------------------------------

function latestObj(state: ObjectState): Record<string, unknown> {
  return state.copy ?? state.base;
}

function prepareObjCopy(state: ObjectState): void {
  if (state.copy === null) {
    state.copy = { ...state.base };
    state.assigned = new Map();
  }
}

const objectTraps: ProxyHandler<object> = {
  get(target, prop) {
    const state = target as unknown as ObjectState;
    if (prop === DRAFT_STATE) return state;
    assertUnrevoked(state);
    const source = latestObj(state);
    if (typeof prop === 'symbol' || !Object.prototype.hasOwnProperty.call(source, prop)) {
      // Prototype fallback — records still carry Object.prototype methods.
      return Reflect.get(source, prop, state.draft);
    }
    const value = source[prop];
    if (state.finalized || !isDraftable(value)) return value;
    // Draft only slots still holding the base value; assigned values and
    // already-created child drafts come back as-is.
    if (value === state.base[prop]) {
      prepareObjCopy(state);
      return (state.copy![prop] = createChildDraft(value, state));
    }
    return value;
  },
  has(target, prop) {
    return prop in latestObj(target as unknown as ObjectState);
  },
  ownKeys(target) {
    return Reflect.ownKeys(latestObj(target as unknown as ObjectState));
  },
  set(target, prop, value) {
    const state = target as unknown as ObjectState;
    assertUnrevoked(state);
    if (typeof prop === 'symbol') {
      throw new TypeError('valsem: records take string keys only');
    }
    const current = latestObj(state)[prop];
    const currentState = stateOf(current);
    if (currentState !== undefined && currentState.base === value) {
      // Assigning the original back over its own draft — not a change.
      prepareObjCopy(state);
      state.copy![prop] = value;
      state.assigned!.set(prop, false);
      return true;
    }
    if (same(value, current) && (value !== undefined || prop in latestObj(state))) {
      return true; // no-op write
    }
    assertAssignable(value, state);
    prepareObjCopy(state);
    markChanged(state);
    state.copy![prop] = value;
    state.assigned!.set(prop, true);
    return true;
  },
  deleteProperty(target, prop) {
    const state = target as unknown as ObjectState;
    assertUnrevoked(state);
    if (typeof prop === 'symbol') return true;
    prepareObjCopy(state);
    if (prop in state.base) {
      state.assigned!.set(prop, false);
      markChanged(state);
    } else {
      state.assigned!.delete(prop);
    }
    delete state.copy![prop];
    return true;
  },
  getOwnPropertyDescriptor(target, prop) {
    const state = target as unknown as ObjectState;
    const owner = latestObj(state);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc) return desc;
    return {
      writable: true,
      configurable: true,
      enumerable: desc.enumerable,
      value: owner[prop as string],
    };
  },
  defineProperty() {
    throw new TypeError('valsem: defineProperty is not supported on drafts');
  },
  getPrototypeOf(target) {
    return Object.getPrototypeOf((target as unknown as ObjectState).base);
  },
  setPrototypeOf() {
    throw new TypeError('valsem: cannot set the prototype of a draft');
  },
};

function createObjectDraft(base: Record<string, unknown>, parent?: AnyState): ObjectState {
  const scope = parent ? parent.scope : currentScope!;
  const state: ObjectState = {
    type: 'object',
    scope,
    parent,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
    base,
    copy: null,
    assigned: null,
    draft: null as unknown as object,
    revoke: null as unknown as () => void,
  };
  const { proxy, revoke } = Proxy.revocable(state as unknown as object, objectTraps);
  state.draft = proxy;
  state.revoke = revoke;
  scope.states.push(state);
  return state;
}

// ---------------------------------------------------------------------------
// Plain-array drafts (Proxy + method interception)
// ---------------------------------------------------------------------------

function latestArr(state: ArrayState): unknown[] {
  return state.copy ?? state.base;
}

function prepareArrCopy(state: ArrayState): void {
  if (state.copy === null) {
    state.copy = state.base.slice();
  }
}

/** Mutating methods captured as intent. */
const CAPTURED: Record<string, (state: ArrayState, args: unknown[]) => unknown> = {
  push(state, args) {
    const at = state.copy!.length;
    state.copy!.push(...args);
    state.ops?.push({ t: 'splice', i: at, rc: 0, inserted: args.slice(), removed: [] });
    return state.copy!.length;
  },
  pop(state) {
    if (state.copy!.length === 0) return undefined;
    const removed = state.copy!.pop();
    state.ops?.push({ t: 'splice', i: state.copy!.length, rc: 1, inserted: [], removed: [removed] });
    return removed;
  },
  shift(state) {
    if (state.copy!.length === 0) return undefined;
    const removed = state.copy!.shift();
    state.ops?.push({ t: 'splice', i: 0, rc: 1, inserted: [], removed: [removed] });
    return removed;
  },
  unshift(state, args) {
    state.copy!.unshift(...args);
    state.ops?.push({ t: 'splice', i: 0, rc: 0, inserted: args.slice(), removed: [] });
    return state.copy!.length;
  },
  splice(state, args) {
    const len = state.copy!.length;
    let start = Math.trunc((args[0] as number) ?? 0);
    start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const rc =
      args.length < 2
        ? len - start
        : Math.min(Math.max(Math.trunc(args[1] as number), 0), len - start);
    const items = args.slice(2);
    const removed = state.copy!.splice(start, rc, ...items);
    state.ops?.push({
      t: 'splice',
      i: start,
      rc,
      inserted: items.slice(),
      removed: removed.slice(),
    });
    return removed;
  },
};

/** Mutating methods with no clean intent mapping: fall back to index diffing. */
const OPAQUE = new Set(['sort', 'reverse', 'fill', 'copyWithin']);

const arrayTraps: ProxyHandler<object> = {
  get(target, prop) {
    const state = (target as [ArrayState])[0]!;
    if (prop === DRAFT_STATE) return state;
    assertUnrevoked(state);
    if (typeof prop === 'string') {
      const captured = CAPTURED[prop];
      if (captured !== undefined) {
        return (...args: unknown[]) => {
          for (const a of args) assertAssignable(a, state);
          prepareArrCopy(state);
          markChanged(state);
          return captured(state, args);
        };
      }
      if (OPAQUE.has(prop)) {
        const fn = (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
          prop
        ]!;
        return (...args: unknown[]) => {
          prepareArrCopy(state);
          markChanged(state);
          state.ops = null; // intent lost — net diff at finalize
          return fn.apply(state.copy!, args);
        };
      }
    }
    const source = latestArr(state);
    if (prop === 'length') return source.length;
    if (typeof prop === 'symbol' || !/^\d+$/.test(prop)) {
      return Reflect.get(source, prop, state.draft);
    }
    const index = Number(prop);
    const value = source[index];
    if (state.finalized || !isDraftable(value)) return value;
    if (value === state.base[index]) {
      prepareArrCopy(state);
      return (state.copy![index] = createChildDraft(value, state));
    }
    return value;
  },
  has(target, prop) {
    return prop in latestArr((target as [ArrayState])[0]!);
  },
  ownKeys(target) {
    return Reflect.ownKeys(latestArr((target as [ArrayState])[0]!));
  },
  set(target, prop, value) {
    const state = (target as [ArrayState])[0]!;
    assertUnrevoked(state);
    if (prop === 'length') {
      prepareArrCopy(state);
      markChanged(state);
      state.ops = null;
      state.copy!.length = value as number;
      return true;
    }
    if (typeof prop === 'symbol' || !/^\d+$/.test(prop)) {
      throw new TypeError(`valsem: arrays take integer indices, got ${String(prop)}`);
    }
    const index = Number(prop);
    const current = latestArr(state)[index];
    if (same(value, current) && index < latestArr(state).length) return true;
    assertAssignable(value, state);
    prepareArrCopy(state);
    markChanged(state);
    if (index >= state.copy!.length) {
      state.ops = null; // sparse growth: net diff
    } else {
      state.ops?.push({ t: 'set', i: index, value, old: state.copy![index] });
    }
    state.copy![index] = value;
    return true;
  },
  deleteProperty(target, prop) {
    // `delete arr[i]` — arrays are positional; treat as set-to-undefined.
    return arrayTraps.set!.call(this, target, prop, undefined, (target as [ArrayState])[0]!.draft);
  },
  getOwnPropertyDescriptor(target, prop) {
    const owner = latestArr((target as [ArrayState])[0]!);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc) return desc;
    return {
      writable: true,
      configurable: prop !== 'length',
      enumerable: desc.enumerable,
      value: (owner as unknown as Record<string | symbol, unknown>)[prop],
    };
  },
  getPrototypeOf() {
    return Array.prototype;
  },
  setPrototypeOf() {
    throw new TypeError('valsem: cannot set the prototype of a draft');
  },
};

function createArrayDraft(base: unknown[], parent?: AnyState): ArrayState {
  const scope = parent ? parent.scope : currentScope!;
  const state: ArrayState = {
    type: 'array',
    scope,
    parent,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
    base,
    copy: null,
    ops: [],
    draft: null as unknown as unknown[],
    revoke: null as unknown as () => void,
  };
  const { proxy, revoke } = Proxy.revocable([state] as unknown as object, arrayTraps);
  state.draft = proxy as unknown as unknown[];
  state.revoke = revoke;
  scope.states.push(state);
  return state;
}

// ---------------------------------------------------------------------------
// Collection drafts
// ---------------------------------------------------------------------------

/** Mutable draft twin of {@link ValueMap}, handed out inside produce(). */
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

  get(key: K): V | undefined {
    const s = this.#state;
    const k = intern(key);
    if (s.edits.has(k)) return s.edits.get(k) as V;
    if (s.assigned.get(k) === false || s.cleared) return undefined;
    const value = s.base.get(k);
    if (value !== undefined && isDraftable(value) && !s.finalized) {
      const child = createChildDraft(value, s);
      s.edits.set(k, child); // child-drafted — deliberately NOT assigned
      return child as V;
    }
    return value as V | undefined;
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
export class DraftList<T> {
  declare readonly [DRAFT_STATE]: ListState;

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

  #items(): unknown[] {
    const s = this.#state;
    if (s.items === null) s.items = s.base.toArray().slice();
    return s.items;
  }

  get length(): number {
    const s = this.#state;
    return s.items === null ? s.base.length : s.items.length;
  }

  get(index: number): T | undefined {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    const items = s.items;
    const value = items === null ? s.base.get(index) : items[index];
    if (isDraftable(value) && !s.finalized && stateOf(value) === undefined) {
      return (this.#items()[index] = createChildDraft(value, s)) as T;
    }
    return value as T;
  }

  set(index: number, value: T): this {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`DraftList.set: index ${index} out of range [0, ${this.length})`);
    }
    const items = this.#items();
    if (same(items[index], value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    s.ops?.push({ t: 'set', i: index, value, old: items[index] });
    items[index] = value;
    return this;
  }

  push(...values: T[]): number {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    const items = this.#items();
    markChanged(s);
    s.ops?.push({ t: 'splice', i: items.length, rc: 0, inserted: values.slice(), removed: [] });
    items.push(...values);
    return items.length;
  }

  pop(): T | undefined {
    const s = this.#state;
    const items = this.#items();
    if (items.length === 0) return undefined;
    markChanged(s);
    const removed = items.pop();
    s.ops?.push({ t: 'splice', i: items.length, rc: 1, inserted: [], removed: [removed] });
    return removed as T;
  }

  splice(start: number, deleteCount?: number, ...values: T[]): T[] {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    const items = this.#items();
    const len = items.length;
    let at = Math.trunc(start);
    at = at < 0 ? Math.max(len + at, 0) : Math.min(at, len);
    const rc =
      deleteCount === undefined
        ? len - at
        : Math.min(Math.max(Math.trunc(deleteCount), 0), len - at);
    markChanged(s);
    const removed = items.splice(at, rc, ...values);
    s.ops?.push({
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
    if (s.items === null) {
      yield* s.base as Iterable<T>;
    } else {
      yield* s.items as T[];
    }
  }

  toArray(): readonly T[] {
    return [...this];
  }
}

function createMapDraft(base: ValueMap<unknown, unknown>, parent?: AnyState): MapState {
  const scope = parent ? parent.scope : currentScope!;
  const state: MapState = {
    type: 'map',
    scope,
    parent,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
    base,
    edits: new Map(),
    assigned: new Map(),
    cleared: false,
    draft: null as unknown as DraftMap<unknown, unknown>,
  };
  state.draft = new DraftMap(INTERNAL, state);
  scope.states.push(state);
  return state;
}

function createSetDraft(base: ValueSet<unknown>, parent?: AnyState): SetState {
  const scope = parent ? parent.scope : currentScope!;
  const state: SetState = {
    type: 'set',
    scope,
    parent,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
    base,
    added: new Set(),
    removed: new Set(),
    cleared: false,
    draft: null as unknown as DraftSet<unknown>,
  };
  state.draft = new DraftSet(INTERNAL, state);
  scope.states.push(state);
  return state;
}

function createListDraft(base: ValueList<unknown>, parent?: AnyState): ListState {
  const scope = parent ? parent.scope : currentScope!;
  const state: ListState = {
    type: 'list',
    scope,
    parent,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
    base,
    items: null,
    ops: [],
    draft: null as unknown as DraftList<unknown>,
  };
  state.draft = new DraftList(INTERNAL, state);
  scope.states.push(state);
  return state;
}

// ---------------------------------------------------------------------------
// Finalize — the intern walk
// ---------------------------------------------------------------------------

/**
 * Resolve any value reachable from a draft to its canonical form: drafts
 * finalize (memoized); canonical values pass in O(1); foreign material
 * adopts — walked once for embedded drafts, then interned.
 */
function resolve(
  value: unknown,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const state = stateOf(value);
  if (state !== undefined) return finalizeState(state, path, recorder);
  return adopt(value);
}

/** Restore-side value for inverse patches: a draft restores its base. */
function restoreValue(value: unknown): unknown {
  const state = stateOf(value);
  if (state !== undefined) return intern(state.base);
  return intern(value);
}

/** Intern foreign material, finalizing any drafts embedded in it. */
function adopt(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // O(1) recognition of canonical material: the [interned] marker covers the
  // collections and pooled value types; the hash cache covers canonical
  // plain data.
  if ((value as Record<symbol, unknown>)[internedMarker] === true || _hashCacheHas(value)) {
    return value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      const resolved = resolve(child, null, undefined);
      if (resolved !== child) changed = true;
      if (resolved !== undefined) out[key] = resolved;
      else if (child !== undefined) changed = true; // record semantics drop undefined
    }
    return intern(changed ? out : value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const child = value[i];
      const resolved = resolve(child, null, undefined);
      if (resolved !== child) changed = true;
      out[i] = resolved;
    }
    return intern(changed ? out : value);
  }
  // Registered immutables pool; class instances pass through; mutable
  // built-ins throw with their teaching errors.
  return intern(value);
}

function finalizeState(
  state: AnyState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  if (state.finalized) return state.result;
  state.finalized = true;

  if (!state.modified) {
    state.result = intern(state.base);
    return state.result;
  }

  switch (state.type) {
    case 'object':
      return finalizeObject(state, path, recorder);
    case 'array':
      return finalizeSequence(
        state,
        state.copy!,
        () => state.base.map((v) => intern(v)),
        (resolved) => intern(resolved),
        path,
        recorder,
      );
    case 'list':
      return finalizeSequence(
        state,
        state.items!,
        () => state.base.toArray() as unknown[],
        (resolved) => ValueList.from(resolved),
        path,
        recorder,
      );
    case 'map':
      return finalizeMap(state, path, recorder);
    case 'set':
      return finalizeSet(state, path, recorder);
  }
}

function finalizeObject(
  state: ObjectState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const copy = state.copy!;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(copy)) {
    // Child-drafted (unassigned) slots emit their own deeper patches; net
    // assignments are covered by this node's record.set patches.
    const childPath =
      path !== null && recorder !== undefined && state.assigned!.get(key) === undefined
        ? [...path, key]
        : null;
    const resolved = resolve(copy[key], childPath, recorder);
    if (resolved !== undefined) out[key] = resolved;
  }
  state.result = intern(out);

  if (recorder !== undefined && path !== null) {
    for (const [key, wasSet] of state.assigned!) {
      const hadBefore = key in state.base;
      const before = state.base[key];
      if (wasSet) {
        const after = out[key];
        if (after === undefined) {
          // Assigned undefined: record semantics — a deletion.
          if (hadBefore && before !== undefined) {
            recorder.patches.push({ kind: 'record.delete', path, key });
            recorder.inverse.unshift({ kind: 'record.set', path, key, value: intern(before) });
          }
          continue;
        }
        const beforeCanonical = hadBefore ? intern(before) : undefined;
        if (hadBefore && same(beforeCanonical, after)) continue; // netted out
        recorder.patches.push({ kind: 'record.set', path, key, value: after });
        recorder.inverse.unshift(
          hadBefore && beforeCanonical !== undefined
            ? { kind: 'record.set', path, key, value: beforeCanonical }
            : { kind: 'record.delete', path, key },
        );
      } else if (hadBefore) {
        recorder.patches.push({ kind: 'record.delete', path, key });
        recorder.inverse.unshift({ kind: 'record.set', path, key, value: intern(before) });
      }
    }
  }
  return state.result;
}

function finalizeSequence(
  state: ArrayState | ListState,
  items: unknown[],
  resolvedBaseOf: () => unknown[],
  makeResult: (resolved: unknown[]) => unknown,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const emitting = recorder !== undefined && path !== null;
  const opsMode = emitting && state.ops !== null;

  // 1) Structural intent first: replay the op log (positions from the log,
  //    operand refs resolved to canonical — later mutations of inserted
  //    drafts are reflected, consistently, in both directions).
  if (opsMode) {
    for (const op of state.ops!) {
      if (op.t === 'set') {
        recorder.patches.push({
          kind: 'list.set',
          path: path!,
          index: op.i,
          value: resolve(op.value, null, undefined),
        });
        recorder.inverse.unshift({
          kind: 'list.set',
          path: path!,
          index: op.i,
          value: restoreValue(op.old),
        });
      } else {
        recorder.patches.push({
          kind: 'list.splice',
          path: path!,
          index: op.i,
          remove: op.rc,
          insert: op.inserted.map((r) => resolve(r, null, undefined)),
        });
        recorder.inverse.unshift({
          kind: 'list.splice',
          path: path!,
          index: op.i,
          remove: op.inserted.length,
          insert: op.removed.map(restoreValue),
        });
      }
    }
  }

  // 2) Resolve the final items. In ops mode, an item that is still an
  //    unfinalized draft was mutated in place (never assigned): its deeper
  //    patches are emitted at its final index — valid after the ops above.
  const resolved = new Array<unknown>(items.length);
  for (let i = 0; i < items.length; i++) {
    const st = stateOf(items[i]);
    const childPath = opsMode && st !== undefined && !st.finalized ? [...path!, i] : null;
    resolved[i] = resolve(items[i], childPath, recorder);
  }
  state.result = makeResult(resolved);

  // 3) Intent lost: net index diff plus one tail splice.
  if (emitting && !opsMode) {
    const base = resolvedBaseOf();
    const common = Math.min(base.length, resolved.length);
    for (let i = 0; i < common; i++) {
      if (!same(base[i], resolved[i])) {
        recorder.patches.push({ kind: 'list.set', path: path!, index: i, value: resolved[i] });
        recorder.inverse.unshift({ kind: 'list.set', path: path!, index: i, value: base[i] });
      }
    }
    if (resolved.length > common) {
      recorder.patches.push({
        kind: 'list.splice',
        path: path!,
        index: common,
        remove: 0,
        insert: resolved.slice(common),
      });
      recorder.inverse.unshift({
        kind: 'list.splice',
        path: path!,
        index: common,
        remove: resolved.length - common,
        insert: [],
      });
    } else if (base.length > common) {
      recorder.patches.push({
        kind: 'list.splice',
        path: path!,
        index: common,
        remove: base.length - common,
        insert: [],
      });
      recorder.inverse.unshift({
        kind: 'list.splice',
        path: path!,
        index: common,
        remove: 0,
        insert: base.slice(common),
      });
    }
  }
  return state.result;
}

function finalizeMap(
  state: MapState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  let result = state.cleared
    ? (ValueMap.empty() as ValueMap<unknown, unknown>)
    : state.base;
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

function finalizeSet(
  state: SetState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  let result = state.cleared ? (ValueSet.empty() as ValueSet<unknown>) : state.base;
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

// ---------------------------------------------------------------------------
// produce
// ---------------------------------------------------------------------------

/** Draft twin of a value type: mutable in place inside a recipe. */
export type Draft<T> = T extends ValueMap<infer K, infer V>
  ? DraftMap<K, V>
  : T extends ValueSet<infer U>
    ? DraftSet<U>
    : T extends ValueList<infer U>
      ? DraftList<U>
      : T extends ReadonlyArray<infer U>
        ? Draft<U>[]
        : T extends object
          ? { -readonly [P in keyof T]: Draft<T[P]> }
          : T;

function runProduce<T>(
  base: T,
  recipe: (draft: Draft<T>) => unknown,
  recorder: PatchRecorder | undefined,
): T {
  const scope: Scope = { parent: currentScope, states: [] };
  currentScope = scope;
  try {
    let rootState: AnyState | undefined;
    let draft: unknown = base;
    if (isDraftable(base)) {
      rootState = isPlainObject(base)
        ? createObjectDraft(base as Record<string, unknown>)
        : Array.isArray(base)
          ? createArrayDraft(base)
          : base instanceof ValueMap
            ? createMapDraft(base)
            : base instanceof ValueSet
              ? createSetDraft(base)
              : createListDraft(base as ValueList<unknown>);
      draft = rootState.draft;
    }

    const returned = recipe(draft as Draft<T>);

    let result: unknown;
    if (returned !== undefined && returned !== draft) {
      if (rootState?.modified) {
        throw new Error(
          'valsem: a recipe may either mutate the draft or return a replacement value — not both.',
        );
      }
      result = returned === nothing ? undefined : resolve(returned, null, undefined);
      if (recorder) {
        recorder.patches.push({ kind: 'replace', path: [], value: result });
        recorder.inverse.unshift({
          kind: 'replace',
          path: [],
          value: intern(base as unknown),
        });
      }
    } else if (rootState !== undefined) {
      result = finalizeState(rootState, recorder ? [] : null, recorder);
    } else {
      result = intern(base as unknown);
    }
    return result as T;
  } finally {
    for (const s of scope.states) {
      s.revoked = true;
      if (s.type === 'object' || s.type === 'array') s.revoke();
    }
    currentScope = scope.parent;
  }
}

/**
 * Run `recipe` against a mutable draft of `base` and return the **canonical**
 * result: `produce(base, r)` is `intern(next state)`. Unchanged inputs — and
 * changes that net out structurally — converge on the canonical base:
 * `produce(base, () => {}) === intern(base)`. Intern is the degenerate case
 * of produce.
 *
 * The curried form `produce(recipe)` returns `base => produce(base, recipe)`.
 */
export function produce<T>(base: T, recipe: (draft: Draft<T>) => unknown): T;
export function produce<T>(recipe: (draft: Draft<T>) => unknown): (base: T) => T;
export function produce<T>(
  baseOrRecipe: T | ((draft: Draft<T>) => unknown),
  recipe?: (draft: Draft<T>) => unknown,
): T | ((base: T) => T) {
  if (recipe === undefined) {
    const r = baseOrRecipe as (draft: Draft<T>) => unknown;
    return (base: T) => runProduce(base, r, undefined);
  }
  return runProduce(baseOrRecipe as T, recipe, undefined);
}

/**
 * Like {@link produce}, additionally returning the semantic patches that turn
 * `base` into the result and the inverse patches that turn the result back
 * into `base` — all patch values canonical.
 */
export function produceWithPatches<T>(
  base: T,
  recipe: (draft: Draft<T>) => unknown,
): [T, Patch[], Patch[]] {
  const recorder: PatchRecorder = { patches: [], inverse: [] };
  const result = runProduce(base, recipe, recorder);
  return [result, recorder.patches, recorder.inverse];
}

/**
 * Apply patches (from {@link produceWithPatches}) to `base`, returning the
 * canonical result. Implemented on top of produce.
 */
export function applyPatches<T>(base: T, patches: readonly Patch[]): T {
  let current: unknown = base;
  const rest: Patch[] = [];
  for (const p of patches) {
    if (p.kind === 'replace') {
      if (p.path.length !== 0) {
        throw new Error('valsem: replace patches must target the root');
      }
      current = p.value;
    } else {
      rest.push(p);
    }
  }
  if (rest.length === 0) return intern(current) as T;
  return produce(current, (draft) => {
    for (const p of rest) {
      const target = navigate(draft, p.path);
      switch (p.kind) {
        case 'record.set':
          (target as Record<string, unknown>)[p.key] = p.value;
          break;
        case 'record.delete':
          delete (target as Record<string, unknown>)[p.key];
          break;
        case 'list.set':
          if (target instanceof DraftList) target.set(p.index, p.value);
          else (target as unknown[])[p.index] = p.value;
          break;
        case 'list.splice':
          if (target instanceof DraftList) {
            target.splice(p.index, p.remove, ...(p.insert as unknown[]));
          } else {
            (target as unknown[]).splice(p.index, p.remove, ...(p.insert as unknown[]));
          }
          break;
        case 'map.set':
          (target as DraftMap<unknown, unknown>).set(p.key, p.value);
          break;
        case 'map.delete':
          (target as DraftMap<unknown, unknown>).delete(p.key);
          break;
        case 'set.add':
          (target as DraftSet<unknown>).add(p.value);
          break;
        case 'set.delete':
          (target as DraftSet<unknown>).delete(p.value);
          break;
      }
    }
  }) as T;
}

function navigate(draft: unknown, path: PatchPath): unknown {
  let cur = draft;
  for (const seg of path) {
    if (cur instanceof DraftMap) cur = cur.get(seg);
    else if (cur instanceof DraftList) cur = cur.get(seg as number);
    else cur = (cur as Record<string | number, unknown>)[seg as string | number];
  }
  return cur;
}
