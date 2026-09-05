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

import { intern, internHash, _hashCacheHas, _accOf, _internPrehashed } from './intern.js';
import { _depthError, _maxDepth } from './limits.js';
import { _entryTerm, _recordHashOf, _arrayHashOf, _powP } from './deep-hash.js';
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
  /**
   * True once a deleted key was re-set: it re-enters the copy at the END,
   * breaking canonical key order — finalize must take the sorting slow path.
   */
  orderBroken: boolean;
  /** Keys whose base value was child-drafted on read. */
  drafted: Set<string> | null;
  draft: object;
  revoke: () => void;
}

interface ArrayState extends BaseState {
  type: 'array';
  base: unknown[];
  /**
   * Virtual mode (copy === null): point edits over the base plus an appended
   * tail — index reads/writes and push/pop never copy the base. A structural
   * op with unstable positions (shift/unshift/splice/sort/…) materializes.
   */
  vEdits: Map<number, unknown>;
  vTail: unknown[];
  copy: unknown[] | null;
  /** Recorded ops (intent); null once an uncapturable mutation occurred. */
  ops: SeqOp[] | null;
  /**
   * True once a relocating mutation ran — sort/reverse/fill/copyWithin, or
   * any captured splice that shifts surviving positions (shift, unshift,
   * mid-array splice with unequal remove/insert counts): base elements may
   * sit at foreign indices, so the base-position check cannot identify them
   * and ANY draftable read must be drafted (immer's relocated-base-refs
   * problem; over-drafting assigned values is safe — `resolve` routes a raw
   * insert to its child draft via `stateOf`).
   */
  opaqued: boolean;
  /** Lazily built set of the base's object elements (opaqued reads only). */
  baseMembers: Set<unknown> | null;
  /** Indices whose base value was child-drafted on read. */
  drafted: Set<number> | null;
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
  /**
   * Virtual mode (items === null): point edits over the base plus an
   * appended tail — no O(n) materialization for get/set/push/pop flows.
   */
  vEdits: Map<number, unknown>;
  vTail: unknown[];
  /** Materialized working array — created only when a splice forces it. */
  items: unknown[] | null;
  /** Always recorded for lists (never goes opaque). */
  ops: SeqOp[];
  /** Indices whose base value was child-drafted on read. */
  drafted: Set<number>;
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
    // Draft slots still holding the base value. Assigned values come back
    // raw (the caller's own material, the immer rule) — EXCEPT frozen ones:
    // an assigned canonical (e.g. `d.c = base.b`) is immutable, so mutating
    // through the read must copy-on-write, not throw on the frozen object
    // (mutative's #18 family).
    if (
      value === state.base[prop] ||
      (stateOf(value) === undefined && Object.isFrozen(value))
    ) {
      prepareObjCopy(state);
      (state.drafted ??= new Set()).add(prop);
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
    if (state.assigned!.get(prop) === false) state.orderBroken = true; // deleted, now re-set
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
    orderBroken: false,
    drafted: null,
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

/**
 * Unfrozen shadows of large frozen bases, so repeat copies run at unfrozen
 * slice speed (~2 µs vs ~9 µs spread at 10k). WeakMap-keyed: a shadow lives
 * and dies with its base (the §8.4 cache law — O(n) caches must be
 * evictable), and is private to copyArr, never mutated, only sliced.
 */
const shadows = new WeakMap<object, unknown[]>();
const copiedOnce = new WeakSet<object>();
const SHADOW_MIN = 64;

/**
 * Copy an array that may be frozen. V8's `slice` fast path does not cover
 * frozen-elements arrays (measured 65× slower); spread does — and for large
 * bases copied REPEATEDLY (fan-out from one state) an unfrozen shadow beats
 * even the spread. The shadow is built only on the second copy of the same
 * base, so one-shot bases (reducer chains) never pay for it.
 */
function copyArr<T>(a: readonly T[]): T[] {
  if (!Object.isFrozen(a)) return (a as T[]).slice();
  if (a.length < SHADOW_MIN) return [...a];
  const s = shadows.get(a as object) as T[] | undefined;
  if (s !== undefined) return s.slice();
  if (copiedOnce.has(a as object)) {
    const built = [...a];
    shadows.set(a as object, built);
    return built.slice();
  }
  copiedOnce.add(a as object);
  return [...a];
}

function arrLen(state: ArrayState): number {
  return state.copy !== null ? state.copy.length : state.base.length + state.vTail.length;
}

function arrRead(state: ArrayState, i: number): unknown {
  if (state.copy !== null) return state.copy[i];
  if (i < state.base.length) {
    return state.vEdits.has(i) ? state.vEdits.get(i) : state.base[i];
  }
  return state.vTail[i - state.base.length];
}

/** Is `value` one of the base array's object elements? (Lazily built.) */
function isBaseMember(state: ArrayState, value: unknown): boolean {
  let members = state.baseMembers;
  if (members === null) {
    members = state.baseMembers = new Set();
    for (const el of state.base) {
      if (el !== null && typeof el === 'object') members.add(el);
    }
  }
  return members.has(value);
}

/** Fold the virtual edits/tail into a materialized working copy. */
function materializeArr(state: ArrayState): unknown[] {
  if (state.copy === null) {
    const c = copyArr(state.base);
    for (const [i, v] of state.vEdits) c[i] = v;
    c.push(...state.vTail);
    state.copy = c;
    state.vEdits.clear();
    state.vTail.length = 0;
  }
  return state.copy;
}

/** Mutating methods captured as intent. push/pop stay virtual; the rest materialize. */
const CAPTURED: Record<string, (state: ArrayState, args: unknown[]) => unknown> = {
  push(state, args) {
    const at = arrLen(state);
    state.ops?.push({ t: 'splice', i: at, rc: 0, inserted: args.slice(), removed: [] });
    if (state.copy !== null) state.copy.push(...args);
    else state.vTail.push(...args);
    return at + args.length;
  },
  pop(state) {
    const len = arrLen(state);
    if (len === 0) return undefined;
    let removed: unknown;
    if (state.copy !== null) removed = state.copy.pop();
    else if (state.vTail.length > 0) removed = state.vTail.pop();
    else removed = materializeArr(state).pop();
    state.ops?.push({ t: 'splice', i: len - 1, rc: 1, inserted: [], removed: [removed] });
    return removed;
  },
  shift(state) {
    const copy = materializeArr(state);
    if (copy.length === 0) return undefined;
    const removed = copy.shift();
    if (copy.length > 0) state.opaqued = true; // survivors relocated
    state.ops?.push({ t: 'splice', i: 0, rc: 1, inserted: [], removed: [removed] });
    return removed;
  },
  unshift(state, args) {
    const copy = materializeArr(state);
    if (args.length > 0 && copy.length > 0) state.opaqued = true; // survivors relocated
    copy.unshift(...args);
    state.ops?.push({ t: 'splice', i: 0, rc: 0, inserted: args.slice(), removed: [] });
    return copy.length;
  },
  splice(state, args) {
    const copy = materializeArr(state);
    const len = copy.length;
    let start = Math.trunc((args[0] as number) ?? 0);
    start = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const rc =
      args.length < 2
        ? len - start
        : Math.min(Math.max(Math.trunc(args[1] as number), 0), len - start);
    const items = args.slice(2);
    if (items.length !== rc && start + rc < len) state.opaqued = true; // survivors relocated
    const removed = copy.splice(start, rc, ...items);
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
          markChanged(state);
          return captured(state, args);
        };
      }
      if (OPAQUE.has(prop)) {
        const fn = (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
          prop
        ]!;
        return (...args: unknown[]) => {
          const copy = materializeArr(state);
          markChanged(state);
          state.ops = null; // intent lost — net diff at finalize
          state.opaqued = true; // base refs may be relocated — see ArrayState
          return fn.apply(copy, args);
        };
      }
    }
    if (prop === 'length') return arrLen(state);
    if (typeof prop === 'symbol' || !/^\d+$/.test(prop)) {
      // Methods and symbols come off Array.prototype; index reads and length
      // during their execution route back through these traps, so iteration
      // and the read-only methods work virtually.
      return Reflect.get(state.copy ?? state.base, prop, state.draft);
    }
    const index = Number(prop);
    const value = arrRead(state, index);
    if (state.finalized || !isDraftable(value)) return value;
    // Draft base-positioned values. Frozen values (canonicals — assigned or
    // relocated) always copy-on-write rather than throw (mutative's #18
    // family). After a relocating method, unfrozen base members may also sit
    // at foreign indices — the membership set identifies them; unfrozen
    // FRESH inserts stay raw so their plain-JS aliasing survives (fill/
    // copyWithin write one object into several slots).
    if (
      value === state.base[index] ||
      (stateOf(value) === undefined &&
        (Object.isFrozen(value) || (state.opaqued && isBaseMember(state, value))))
    ) {
      (state.drafted ??= new Set()).add(index);
      const child = createChildDraft(value, state);
      if (state.copy !== null) state.copy[index] = child;
      else state.vEdits.set(index, child);
      return child;
    }
    return value;
  },
  has(target, prop) {
    const state = (target as [ArrayState])[0]!;
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < arrLen(state);
    return prop in (state.copy ?? state.base);
  },
  ownKeys(target) {
    // Needs the full key list — the one read that forces materialization.
    return Reflect.ownKeys(materializeArr((target as [ArrayState])[0]!));
  },
  set(target, prop, value) {
    const state = (target as [ArrayState])[0]!;
    assertUnrevoked(state);
    if (prop === 'length') {
      materializeArr(state);
      markChanged(state);
      state.ops = null;
      state.copy!.length = value as number;
      return true;
    }
    if (typeof prop === 'symbol' || !/^\d+$/.test(prop)) {
      throw new TypeError(`valsem: arrays take integer indices, got ${String(prop)}`);
    }
    const index = Number(prop);
    const len = arrLen(state);
    const current = index < len ? arrRead(state, index) : undefined;
    if (same(value, current) && index < len) return true;
    assertAssignable(value, state);
    markChanged(state);
    if (index >= len) {
      // Sparse growth: net diff.
      const copy = materializeArr(state);
      state.ops = null;
      copy[index] = value;
      return true;
    }
    state.ops?.push({ t: 'set', i: index, value, old: current });
    if (state.copy !== null) state.copy[index] = value;
    else if (index < state.base.length) state.vEdits.set(index, value);
    else state.vTail[index - state.base.length] = value;
    return true;
  },
  deleteProperty(target, prop) {
    // `delete arr[i]` — arrays are positional; treat as set-to-undefined.
    return arrayTraps.set!.call(this, target, prop, undefined, (target as [ArrayState])[0]!.draft);
  },
  getOwnPropertyDescriptor(target, prop) {
    const state = (target as [ArrayState])[0]!;
    if (typeof prop === 'string' && /^\d+$/.test(prop)) {
      const index = Number(prop);
      if (index >= arrLen(state)) return undefined;
      return {
        writable: true,
        configurable: true,
        enumerable: true,
        value: arrRead(state, index),
      };
    }
    if (prop === 'length') {
      return { writable: true, configurable: false, enumerable: false, value: arrLen(state) };
    }
    const desc = Reflect.getOwnPropertyDescriptor(state.copy ?? state.base, prop);
    if (!desc) return desc;
    return {
      writable: true,
      configurable: true,
      enumerable: desc.enumerable,
      value: (state.copy ?? (state.base as unknown as Record<string | symbol, unknown>))[
        prop as never
      ],
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
    vEdits: new Map(),
    vTail: [],
    copy: null,
    ops: [],
    opaqued: false,
    baseMembers: null,
    drafted: null,
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
        return child as V;
      }
      return edited as V;
    }
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

  /** Fold the virtual edits/tail into a materialized working array. */
  #materialize(): unknown[] {
    const s = this.#state;
    if (s.items === null) {
      const items = [...s.base.toArray()]; // spread: the snapshot is frozen
      for (const [i, v] of s.vEdits) items[i] = v;
      items.push(...s.vTail);
      s.items = items;
      s.vEdits.clear();
      s.vTail.length = 0;
    }
    return s.items;
  }

  get length(): number {
    const s = this.#state;
    return s.items === null ? s.base.length + s.vTail.length : s.items.length;
  }

  /** Current value at `index`; only base-positioned values are child-drafted. */
  #read(index: number): unknown {
    const s = this.#state;
    if (s.items !== null) return s.items[index];
    if (index < s.base.length) {
      return s.vEdits.has(index) ? s.vEdits.get(index) : s.base.get(index);
    }
    return s.vTail[index - s.base.length];
  }

  get(index: number): T | undefined {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    const value = this.#read(index);
    // Draft values still at their base position (assigned/inserted material
    // is the caller's own and comes back raw — the immer rule), and frozen
    // assigned values (canonicals must copy-on-write, not throw — mutative's
    // #18 family).
    if (
      isDraftable(value) &&
      !s.finalized &&
      stateOf(value) === undefined &&
      (value === s.base.get(index) || Object.isFrozen(value))
    ) {
      const child = createChildDraft(value, s);
      s.drafted.add(index);
      if (s.items !== null) s.items[index] = child;
      else s.vEdits.set(index, child);
      return child as T;
    }
    return value as T;
  }

  set(index: number, value: T): this {
    const s = this.#state;
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`DraftList.set: index ${index} out of range [0, ${this.length})`);
    }
    const current = this.#read(index);
    if (same(current, value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    s.ops.push({ t: 'set', i: index, value, old: current });
    if (s.items !== null) s.items[index] = value;
    else if (index < s.base.length) s.vEdits.set(index, value);
    else s.vTail[index - s.base.length] = value;
    return this;
  }

  push(...values: T[]): number {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    markChanged(s);
    const len = this.length;
    s.ops.push({ t: 'splice', i: len, rc: 0, inserted: values.slice(), removed: [] });
    if (s.items !== null) s.items.push(...values);
    else s.vTail.push(...values);
    return len + values.length;
  }

  pop(): T | undefined {
    const s = this.#state;
    const len = this.length;
    if (len === 0) return undefined;
    markChanged(s);
    let removed: unknown;
    if (s.items !== null) {
      removed = s.items.pop();
    } else if (s.vTail.length > 0) {
      removed = s.vTail.pop();
    } else {
      removed = this.#materialize().pop();
    }
    s.ops.push({ t: 'splice', i: len - 1, rc: 1, inserted: [], removed: [removed] });
    return removed as T;
  }

  splice(start: number, deleteCount?: number, ...values: T[]): T[] {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    const items = this.#materialize();
    const len = items.length;
    let at = Math.trunc(start);
    at = at < 0 ? Math.max(len + at, 0) : Math.min(at, len);
    const rc =
      deleteCount === undefined
        ? len - at
        : Math.min(Math.max(Math.trunc(deleteCount), 0), len - at);
    markChanged(s);
    const removed = items.splice(at, rc, ...values);
    s.ops.push({
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
    if (s.items !== null) {
      yield* s.items as T[];
    } else if (s.vEdits.size === 0 && s.vTail.length === 0) {
      yield* s.base as Iterable<T>;
    } else {
      const baseLen = s.base.length;
      for (let i = 0; i < baseLen; i++) {
        yield (s.vEdits.has(i) ? s.vEdits.get(i) : s.base.get(i)) as T;
      }
      yield* s.vTail as T[];
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
    vEdits: new Map(),
    vTail: [],
    items: null,
    ops: [],
    drafted: new Set(),
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

let adoptDepth = 0;

/** Intern foreign material, finalizing any drafts embedded in it. */
function adopt(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // O(1) recognition of canonical material: the [interned] marker covers the
  // collections and pooled value types; the hash cache covers canonical
  // plain data.
  if ((value as Record<symbol, unknown>)[internedMarker] === true || _hashCacheHas(value)) {
    return value;
  }
  // Same decode-boundary depth cap as intern: adopt recurses over foreign
  // material a recipe grafted in, which can be hostile or cyclic.
  if (++adoptDepth > _maxDepth()) throw _depthError('produce');
  try {
    return adoptUncached(value);
  } finally {
    adoptDepth--;
  }
}

function adoptUncached(value: object): unknown {
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
      return finalizeArray(state, path, recorder);
    case 'list':
      return finalizeList(state, path, recorder);
    case 'map':
      return finalizeMap(state, path, recorder);
    case 'set':
      return finalizeSet(state, path, recorder);
  }
}

/** Emit the recorded structural ops of a sequence as patches, both directions. */
function emitSeqOps(ops: SeqOp[], path: PatchPath, recorder: PatchRecorder): void {
  for (const op of ops) {
    if (op.t === 'set') {
      recorder.patches.push({
        kind: 'list.set',
        path,
        index: op.i,
        value: resolve(op.value, null, undefined),
      });
      recorder.inverse.unshift({
        kind: 'list.set',
        path,
        index: op.i,
        value: restoreValue(op.old),
      });
    } else {
      recorder.patches.push({
        kind: 'list.splice',
        path,
        index: op.i,
        remove: op.rc,
        insert: op.inserted.map((r) => resolve(r, null, undefined)),
      });
      recorder.inverse.unshift({
        kind: 'list.splice',
        path,
        index: op.i,
        remove: op.inserted.length,
        insert: op.removed.map(restoreValue),
      });
    }
  }
}

/**
 * Retract a sequence node's own op patches after finalize concluded the
 * successor IS the base. Op patches must be emitted BEFORE children resolve
 * (children patch against post-splice indices), so a netted-out sequence
 * leaves its ops in the recorder; on the `=== base` outcome no child can
 * have emitted (a changed child forces a different result), so the marked
 * regions hold exactly this node's entries: `patchMark..` in `patches`,
 * the first `inverseCount` in `inverse` (one unshift per op).
 */
function retractSeqPatches(
  recorder: PatchRecorder,
  patchMark: number,
  inverseCount: number,
): void {
  recorder.patches.length = patchMark;
  recorder.inverse.splice(0, inverseCount);
}

/** Net index diff plus one tail splice — the intent-lost patch fallback. */
function emitSeqDiff(
  base: unknown[],
  resolved: unknown[],
  path: PatchPath,
  recorder: PatchRecorder,
): void {
  const common = Math.min(base.length, resolved.length);
  for (let i = 0; i < common; i++) {
    if (!same(base[i], resolved[i])) {
      recorder.patches.push({ kind: 'list.set', path, index: i, value: resolved[i] });
      recorder.inverse.unshift({ kind: 'list.set', path, index: i, value: base[i] });
    }
  }
  if (resolved.length > common) {
    recorder.patches.push({
      kind: 'list.splice',
      path,
      index: common,
      remove: 0,
      insert: resolved.slice(common),
    });
    recorder.inverse.unshift({
      kind: 'list.splice',
      path,
      index: common,
      remove: resolved.length - common,
      insert: [],
    });
  } else if (base.length > common) {
    recorder.patches.push({
      kind: 'list.splice',
      path,
      index: common,
      remove: base.length - common,
      insert: [],
    });
    recorder.inverse.unshift({
      kind: 'list.splice',
      path,
      index: common,
      remove: 0,
      insert: base.slice(common),
    });
  }
}

/**
 * If every op is a positional set or a tail splice, positions BELOW the
 * low-water mark are stable: return the assigned indices, the final length,
 * and `low` — the minimum length reached. Everything at index ≥ low was
 * rewritten by the tail-splice sequence (pop-then-push changes content at
 * indices below the base length without changing the length!) and must be
 * taken from the final items, not delta'd. Mid-sequence splices → null.
 */
function seqTailProfile(
  ops: SeqOp[],
  baseLen: number,
): { setIdx: Set<number>; finalLen: number; low: number } | null {
  let len = baseLen;
  let low = baseLen;
  const setIdx = new Set<number>();
  for (const op of ops) {
    if (op.t === 'set') {
      setIdx.add(op.i);
    } else {
      if (op.i + op.rc !== len) return null;
      len = op.i + op.inserted.length;
      if (op.i < low) low = op.i;
    }
  }
  return { setIdx, finalLen: len, low };
}

function finalizeObject(
  state: ObjectState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const copy = state.copy!;
  const base = state.base;
  const emitting = recorder !== undefined && path !== null;

  // Touched slots: assignments/deletions plus child-drafted reads. Everything
  // else in the copy is the base's own (canonical when base is) material.
  const touched = new Set<string>(state.assigned!.keys());
  if (state.drafted !== null) for (const k of state.drafted) touched.add(k);

  // Fast path: canonical base with a cached accumulator, and no ADDED keys
  // (an addition lands unsorted at the end of the copy, breaking the
  // canonical key order — those take the sorting slow path).
  const accInfo = _accOf(base);
  let fast = accInfo !== undefined && !state.orderBroken;
  let acc = accInfo !== undefined ? accInfo.a : 0;
  let n = accInfo !== undefined ? accInfo.n : 0;

  for (const key of touched) {
    const hadBefore = key in base && base[key] !== undefined;
    if (!Object.prototype.hasOwnProperty.call(copy, key)) {
      // Deleted via delete — the copy already lacks it.
      if (fast && hadBefore) {
        acc = (acc - _entryTerm(key, internHash(base[key]))) >>> 0;
        n--;
      }
      continue;
    }
    const childPath =
      emitting && state.assigned!.get(key) === undefined ? [...path!, key] : null;
    const resolved = resolve(copy[key], childPath, recorder);
    if (resolved === undefined) {
      delete copy[key]; // assigned undefined — record semantics: absent
      if (fast && hadBefore) {
        acc = (acc - _entryTerm(key, internHash(base[key]))) >>> 0;
        n--;
      }
      continue;
    }
    copy[key] = resolved;
    if (fast) {
      if (!hadBefore) {
        fast = false;
      } else {
        acc =
          (acc -
            _entryTerm(key, internHash(base[key])) +
            _entryTerm(key, internHash(resolved))) >>>
          0;
      }
    }
  }

  state.result = fast
    ? _internPrehashed(copy, _recordHashOf(n, acc), acc, n)
    : intern(copy);

  if (emitting) {
    for (const [key, wasSet] of state.assigned!) {
      const hadBefore = key in base && base[key] !== undefined;
      const before = base[key];
      if (wasSet) {
        const after = Object.prototype.hasOwnProperty.call(copy, key)
          ? copy[key]
          : undefined;
        if (after === undefined) {
          if (hadBefore) {
            recorder.patches.push({ kind: 'record.delete', path: path!, key });
            recorder.inverse.unshift({
              kind: 'record.set',
              path: path!,
              key,
              value: intern(before),
            });
          }
          continue;
        }
        const beforeCanonical = hadBefore ? intern(before) : undefined;
        if (hadBefore && same(beforeCanonical, after)) continue; // netted out
        recorder.patches.push({ kind: 'record.set', path: path!, key, value: after });
        recorder.inverse.unshift(
          hadBefore && beforeCanonical !== undefined
            ? { kind: 'record.set', path: path!, key, value: beforeCanonical }
            : { kind: 'record.delete', path: path!, key },
        );
      } else if (hadBefore) {
        recorder.patches.push({ kind: 'record.delete', path: path!, key });
        recorder.inverse.unshift({
          kind: 'record.set',
          path: path!,
          key,
          value: intern(before),
        });
      }
    }
  }
  return state.result;
}

// ---------------------------------------------------------------------------
// Transition memoization — repeat produces skip O(n) verification
//
// A successor is a pure function of (canonical base, exact delta). Caching a
// few recent transitions per base makes recurrent states resolve in
// O(touched): matching base identity + delta identity PROVES the result,
// with no hash trust and no structural walk.
// ---------------------------------------------------------------------------

interface Transition {
  h: number;
  len: number;
  keys: number[]; // touched base-region indices, ascending
  vals: unknown[]; // their resolved canonical values
  app: unknown[]; // resolved appended region
  ref: WeakRef<object>;
}

const transitions = new WeakMap<object, Transition[]>();
const TRANSITION_CAP = 16;

function lookupTransition(
  base: object,
  h: number,
  len: number,
  keys: number[],
  vals: unknown[],
  app: unknown[],
): object | undefined {
  const list = transitions.get(base);
  if (list === undefined) return undefined;
  for (let t = 0; t < list.length; t++) {
    const entry = list[t]!;
    if (
      entry.h !== h ||
      entry.len !== len ||
      entry.keys.length !== keys.length ||
      entry.app.length !== app.length
    ) {
      continue;
    }
    let ok = true;
    for (let k = 0; ok && k < keys.length; k++) {
      ok = entry.keys[k] === keys[k] && same(entry.vals[k], vals[k]);
    }
    for (let k = 0; ok && k < app.length; k++) ok = same(entry.app[k], app[k]);
    if (!ok) continue;
    const result = entry.ref.deref();
    if (result === undefined) {
      list.splice(t, 1);
      t--;
      continue;
    }
    return result;
  }
  return undefined;
}

function storeTransition(
  base: object,
  h: number,
  len: number,
  keys: number[],
  vals: unknown[],
  app: unknown[],
  result: object,
): void {
  let list = transitions.get(base);
  if (list === undefined) transitions.set(base, (list = []));
  list.unshift({ h, len, keys, vals, app, ref: new WeakRef(result) });
  if (list.length > TRANSITION_CAP) list.pop();
}

function finalizeArray(
  state: ArrayState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const emitting = recorder !== undefined && path !== null;
  const opsMode = state.ops !== null;

  const patchMark = emitting ? recorder!.patches.length : 0;
  const opCount = opsMode ? state.ops!.length : 0;
  if (emitting && opsMode) emitSeqOps(state.ops!, path!, recorder);

  const base = state.base;
  const accInfo = _accOf(base);
  const profile = opsMode ? seqTailProfile(state.ops!, base.length) : null;
  const virtual = state.copy === null;
  const L = base.length;
  const L2 = arrLen(state);

  if (accInfo !== undefined && profile !== null && profile.finalLen === L2) {
    // Fast path — stable positions below the low-water mark. Assemble the
    // exact delta (touched indices below `low`, plus the rewritten region
    // [low, L2)), delta-update the accumulator, and try the transition
    // cache before building anything O(n).
    const low = profile.low; // indices ≥ low were rewritten by tail splices
    const assignedIdx = profile.setIdx;
    let acc = accInfo.a | 0;

    const touched = new Set(assignedIdx);
    if (state.drafted !== null) for (const i of state.drafted) touched.add(i);
    const keys: number[] = [];
    const vals: unknown[] = [];
    for (const i of [...touched].sort((a, b) => a - b)) {
      if (i >= low) continue; // rewritten region — taken from final items below
      const childPath = emitting && !assignedIdx.has(i) ? [...path!, i] : null;
      const resolved = resolve(arrRead(state, i), childPath, recorder);
      if (same(resolved, base[i])) {
        // Netted out — but a materialized copy holds the child DRAFT at this
        // index (written by the read trap); restore the base value so the
        // built successor cannot embed a revoked proxy.
        if (!virtual) state.copy![i] = base[i];
        continue;
      }
      keys.push(i);
      vals.push(resolved);
      acc = (acc + Math.imul(internHash(resolved) - internHash(base[i]), _powP(i))) | 0;
    }
    // Rewritten region: subtract the base's [low, L), add the final [low, L2).
    // (`low` is derivable as L2 − app.length, so the transition signature
    // stays unambiguous.)
    const app: unknown[] = [];
    for (let i = low; i < L; i++) {
      acc = (acc - Math.imul(internHash(base[i]), _powP(i))) | 0;
    }
    for (let i = low; i < L2; i++) {
      const resolved = resolve(arrRead(state, i), null, recorder);
      app.push(resolved);
      acc = (acc + Math.imul(internHash(resolved), _powP(i))) | 0;
    }
    acc = acc >>> 0;

    if (keys.length === 0 && app.length === 0 && L2 === L) {
      // Everything netted out: the successor IS the (canonical) base.
      if (emitting) retractSeqPatches(recorder!, patchMark, opCount);
      state.result = base;
      return base;
    }

    const h = _arrayHashOf(L2, acc);
    const hit = lookupTransition(base, h, L2, keys, vals, app);
    if (hit !== undefined) {
      if (emitting && hit === base) retractSeqPatches(recorder!, patchMark, opCount);
      state.result = hit;
      return hit;
    }

    // Build the successor — the only O(n) step, skipped entirely on a hit.
    const out = virtual ? copyArr(base) : state.copy!;
    for (let k = 0; k < keys.length; k++) out[keys[k]!] = vals[k];
    for (let k = 0; k < app.length; k++) out[low + k] = app[k];
    out.length = L2;
    state.result = _internPrehashed(out, h, acc, L2);
    // Content-equal-to-base is still possible here (e.g. pop then push of
    // the same value): the pool hands back the base itself.
    if (emitting && state.result === base) retractSeqPatches(recorder!, patchMark, opCount);
    storeTransition(base, h, L2, keys, vals, app, state.result as object);
    return state.result;
  }

  // Slow path: materialize, resolve everything, intern; net diff when intent
  // was lost.
  const copy = materializeArr(state);
  const resolved = new Array<unknown>(copy.length);
  for (let i = 0; i < copy.length; i++) {
    const st = stateOf(copy[i]);
    const childPath =
      emitting && opsMode && st !== undefined && !st.finalized ? [...path!, i] : null;
    resolved[i] = resolve(copy[i], childPath, recorder);
  }
  state.result = intern(resolved);
  if (emitting && opsMode && state.result === base) {
    retractSeqPatches(recorder!, patchMark, opCount);
  }
  if (emitting && !opsMode) {
    // Array.from (not .map): the base may be frozen — see copyArr.
    emitSeqDiff(
      Array.from(state.base, (v) => intern(v)),
      resolved,
      path!,
      recorder,
    );
  }
  return state.result;
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

  const assignedIdx = new Set<number>();
  for (const op of state.ops) if (op.t === 'set') assignedIdx.add(op.i);

  if (state.items === null) {
    // Virtual mode: replay point edits and the appended tail onto the base
    // persistently — O(edits · log n), no materialization ever happened.
    let result = state.base;
    for (const [i, v] of state.vEdits) {
      const childPath = emitting && !assignedIdx.has(i) ? [...path!, i] : null;
      result = result.set(i, resolve(v, childPath, recorder));
    }
    for (const v of state.vTail) {
      result = result.push(resolve(v, null, recorder));
    }
    if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
    state.result = result;
    return result;
  }

  const items = state.items;
  const profile = seqTailProfile(state.ops, state.base.length);
  if (profile !== null && profile.finalLen === items.length) {
    // Materialized but positions stable below the low-water mark: replay
    // persistently — sets below `low`, then rebuild the rewritten tail.
    const L = state.base.length;
    const L2 = items.length;
    const low = profile.low;
    let result = state.base;
    const touched = new Set(assignedIdx);
    for (const i of state.drafted) touched.add(i);
    for (const i of touched) {
      if (i >= low) continue;
      const childPath = emitting && !assignedIdx.has(i) ? [...path!, i] : null;
      result = result.set(i, resolve(items[i], childPath, recorder));
    }
    for (let k = low; k < L; k++) result = result.pop();
    for (let i = low; i < L2; i++) result = result.push(resolve(items[i], null, recorder));
    if (emitting && result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
    state.result = result;
    return result;
  }

  // Mid-sequence splices: rebuild from the resolved items.
  const resolved = new Array<unknown>(items.length);
  for (let i = 0; i < items.length; i++) {
    const st = stateOf(items[i]);
    const childPath =
      emitting && st !== undefined && !st.finalized ? [...path!, i] : null;
    resolved[i] = resolve(items[i], childPath, recorder);
  }
  state.result = ValueList.from(resolved);
  if (emitting && state.result === state.base) retractSeqPatches(recorder!, patchMark, opCount);
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
      // A thenable replacement is almost certainly an `async` recipe — which
      // would otherwise leak the raw Promise out as the "result" (intern
      // passes unregistered class instances through). Reject it loudly.
      if (typeof (returned as { then?: unknown } | null)?.then === 'function') {
        throw new Error(
          'valsem: recipes must be synchronous — an async recipe returns a Promise, ' +
            'which is not a value. Await your data first, then produce.',
        );
      }
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
export function produce<T>(
  recipe: (draft: Draft<T>, ...args: never[]) => unknown,
): (base: T, ...args: unknown[]) => T;
export function produce<T>(
  baseOrRecipe: T | ((draft: Draft<T>, ...args: unknown[]) => unknown),
  recipe?: (draft: Draft<T>) => unknown,
): T | ((base: T, ...args: unknown[]) => T) {
  if (recipe === undefined) {
    const r = baseOrRecipe as (draft: Draft<T>, ...args: unknown[]) => unknown;
    // Curried form: extra call arguments flow into the recipe (immer's
    // convention — `setState(produce(toggle, id))` style).
    return (base: T, ...args: unknown[]) => runProduce(base, (d) => r(d, ...args), undefined);
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
