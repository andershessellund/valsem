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

import { intern, internHash, _accOf, _internPrehashed } from './intern.js';
import { _entryTerm, _recordHashOf, _arrayHashOf, _powP } from './deep-hash.js';
import { _defineRecordField, _recordKeys, equals, hashCode, interned } from './deep-equal.js';
import {
  toDraft,
  DRAFT_STATE,
  createDraftState,
  draftOf,
  stateOf,
  isDraftable,
  same,
  markChanged,
  assertUnrevoked,
  assertAssignable,
  createChildDraft,
  resolve,
  finalizeState,
  emitSeqOps,
  retractSeqPatches,
  seqTailProfile,
  snapshotOf,
  _runInScope,
  _setCoreDraftFactories,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
  type SeqOp,
} from './draft-core.js';

export { isDraft, toDraft } from './draft-core.js';
export type { Patch, PatchPath, PatchKinds, PatchRecorder, DraftState } from './draft-core.js';

/** Recipe return sentinel: "the result is `undefined`" (distinct from returning nothing). */
export const nothing: unique symbol = Symbol('valsem.nothing');

// ---------------------------------------------------------------------------
// Patch vocabulary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scope and draft states
// ---------------------------------------------------------------------------

/** A plain record: own enumerable string and symbol keys. */
type Rec = Record<string | symbol, unknown>;

interface ObjectState extends DraftState<Rec> {
  kind: 'object';
  copy: Rec | null;
  /** true = set, false = deleted; absent key = only child-drafted. */
  assigned: Map<string | symbol, boolean> | null;
  /**
   * True once a deleted key was re-set: it re-enters the copy at the END,
   * breaking canonical key order — finalize must take the sorting slow path.
   */
  orderBroken: boolean;
  /** Keys whose base value was child-drafted on read. */
  drafted: Set<string | symbol> | null;
  draft: object;
  revoke: () => void;
}

interface ArrayState extends DraftState<unknown[]> {
  kind: 'array';
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** SameValueZero. */
// Records are keyed by OWN properties only. Every membership test on a base
// or copy goes through this rather than `in`, which walks the prototype
// chain: `'toString' in {}` is true, and treating Object.prototype's
// members as base keys hands functions to the hasher and misreports
// deletions/inverse patches for every hostile or merely unlucky key name.
const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `rec[key]` for an OWN key, `undefined` otherwise (never the prototype's). */
function ownValue(rec: Rec, key: string | symbol): unknown {
  return hasOwn(rec, key) ? rec[key] : undefined;
}

// ---------------------------------------------------------------------------
// Plain-object drafts (Proxy)
// ---------------------------------------------------------------------------

function latestObj(state: ObjectState): Rec {
  return state.copy ?? state.base;
}

function prepareObjCopy(state: ObjectState): void {
  if (state.copy === null) {
    const base = state.base;
    // Object.assign, not `{ ...base }`: object spread goes through V8's
    // CloneObjectIC, and this one site sees every record shape in the
    // application, so it is megamorphic in practice — the generic fallback
    // costs ~100 ns per property (a 1000-key record: 110 µs instead of 1).
    // Object.assign's builtin fast path keys on the source map directly and
    // stays at memcpy speed at any site. The one semantic difference is an
    // own `__proto__` key, which [[Set]] would swallow: those take the spread.
    state.copy = hasOwn(base, '__proto__') ? { ...base } : Object.assign({}, base);
    state.assigned = new Map();
  }
}

const objectTraps: ProxyHandler<object> = {
  get(target, prop) {
    const state = target as unknown as ObjectState;
    if (prop === DRAFT_STATE) return state;
    assertUnrevoked(state);
    const source = latestObj(state);
    if (!Object.prototype.hasOwnProperty.call(source, prop)) {
      // Prototype fallback — records still carry Object.prototype methods,
      // and the well-known symbols inspectors probe for live here too.
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
    if (typeof prop === 'symbol') assertNotReserved(prop);
    const current = ownValue(latestObj(state), prop);
    const currentState = stateOf(current);
    if (currentState !== undefined && currentState.base === value) {
      // Assigning the original back over its own draft — not a change.
      prepareObjCopy(state);
      _defineRecordField(state.copy!, prop, value);
      state.assigned!.set(prop, false);
      return true;
    }
    if (same(value, current) && (value !== undefined || hasOwn(latestObj(state), prop))) {
      return true; // no-op write
    }
    assertAssignable(value, state);
    prepareObjCopy(state);
    markChanged(state);
    if (state.assigned!.get(prop) === false) state.orderBroken = true; // deleted, now re-set
    // Define semantics, as intern does: a `__proto__` key must become an own
    // data property, not fire Object.prototype's setter.
    _defineRecordField(state.copy!, prop, value);
    state.assigned!.set(prop, true);
    return true;
  },
  deleteProperty(target, prop) {
    const state = target as unknown as ObjectState;
    assertUnrevoked(state);
    prepareObjCopy(state);
    if (hasOwn(state.base, prop)) {
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
      value: owner[prop],
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

/**
 * The protocol symbols are reserved keys: a record carrying `[hashCode]` or
 * `[interned]` would read as self-hashing or canonical to every walk, and
 * `[equals]`/`[toDraft]` would turn a record into a kind. Writing them into
 * a draft is a bug, not a value.
 */
function assertNotReserved(prop: symbol): void {
  if (
    prop === DRAFT_STATE ||
    prop === equals ||
    prop === hashCode ||
    prop === interned ||
    prop === toDraft
  ) {
    throw new TypeError(`valsem: ${String(prop)} is a reserved protocol key and cannot be set on a record`);
  }
}

function createObjectDraft(base: Rec, parent?: DraftState): ObjectState {
  const state = createDraftState<ObjectState>({
    kind: 'object',
    parent,
    base,
    copy: null,
    assigned: null,
    orderBroken: false,
    drafted: null,
    draft: null as unknown as object,
    revoke: null as unknown as () => void,
    finalize: finalizeObject,
  });
  const { proxy, revoke } = Proxy.revocable(state as unknown as object, objectTraps);
  state.draft = proxy;
  state.revoke = revoke;
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

function createArrayDraft(base: unknown[], parent?: DraftState): ArrayState {
  const state = createDraftState<ArrayState>({
    kind: 'array',
    parent,
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
    finalize: finalizeArray,
  });
  const { proxy, revoke } = Proxy.revocable([state] as unknown as object, arrayTraps);
  state.draft = proxy as unknown as unknown[];
  state.revoke = revoke;
  return state;
}

// The two built-in kinds, registered with the core so draftOf()/createChildDraft()
// reach them without draft-core depending on this module. (A top-level call,
// but not a side effect a bundler must preserve: it only matters once
// `produce` is called, and then this module is in the bundle anyway — so the
// package declares this file side-effect-free and produce-less bundles drop
// it.)
_setCoreDraftFactories(createObjectDraft, createArrayDraft);


/** Mutable draft twin of {@link ValueMap}, handed out inside produce(). */
// ---------------------------------------------------------------------------
// Finalize — the intern walk
// ---------------------------------------------------------------------------

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
  const touched = new Set<string | symbol>(state.assigned!.keys());
  if (state.drafted !== null) for (const k of state.drafted) touched.add(k);

  // Fast path: canonical base with a cached accumulator, and no ADDED keys
  // (an addition lands unsorted at the end of the copy, breaking the
  // canonical key order — those take the sorting slow path).
  const accInfo = _accOf(base);
  let fast = accInfo !== undefined && !state.orderBroken;
  let acc = accInfo !== undefined ? accInfo.a : 0;
  let n = accInfo !== undefined ? accInfo.n : 0;

  for (const key of touched) {
    const hadBefore = hasOwn(base, key) && base[key] !== undefined;
    if (!hasOwn(copy, key)) {
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
      const hadBefore = hasOwn(base, key) && base[key] !== undefined;
      const before = ownValue(base, key);
      if (wasSet) {
        const after = ownValue(copy, key);
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

// ---------------------------------------------------------------------------
// produce
// ---------------------------------------------------------------------------

/**
 * The draft twin of a value type — mutable in place inside a recipe.
 *
 * Plain objects and arrays map to their writable shapes; anything that
 * implements `[toDraft]` maps to whatever its draft state's `draft` is
 * (`ValueMap<K, V>` → `DraftMap<K, V>`, and likewise for your own types).
 */
export type Draft<T> = T extends { [toDraft](parent?: DraftState): { draft: infer D } }
  ? D
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
  return _runInScope(() => {
    let rootState: DraftState | undefined;
    let draft: unknown = base;
    if (isDraftable(base)) {
      rootState = draftOf(base);
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
  });
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
  // Patches apply strictly in sequence. A root `replace` ends the current
  // run of draft edits (they must land on the value as it was BEFORE the
  // replacement) and starts the next run on the replacement value.
  let current: unknown = base;
  let run: Patch[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const batch = run;
    run = [];
    current = produce(current, (draft) => applyRun(draft, batch));
  };
  for (const p of patches) {
    if (p.kind === 'replace') {
      if (p.path.length !== 0) {
        throw new Error('valsem: replace patches must target the root');
      }
      flush();
      current = p.value;
    } else {
      run.push(p);
    }
  }
  flush();
  return intern(current) as T;
}

/** Apply one run of non-replace patches to a draft, in order. */
function applyRun(draft: unknown, patches: readonly Patch[]): void {
  for (const p of patches) {
    const target = navigate(draft, p.path);
    const state = stateOf(target);
    if (state !== undefined && state.applyPatch !== undefined) {
      state.applyPatch(state, p); // a draftable kind applies its own patches
      continue;
    }
    switch (p.kind) {
      case 'record.set':
        (target as Rec)[p.key] = p.value;
        break;
      case 'record.delete':
        delete (target as Rec)[p.key];
        break;
      case 'list.set':
        (target as unknown[])[p.index] = p.value;
        break;
      case 'list.splice':
        (target as unknown[]).splice(p.index, p.remove, ...(p.insert as unknown[]));
        break;
      default:
        throw new Error(`valsem: cannot apply a '${p.kind}' patch to a ${describe(target)}`);
    }
  }
}

/**
 * @internal `current()`'s view of the two core kinds: a plain copy with nested
 * drafts snapshotted, the state untouched. Lives here for the array
 * accessors; referenced only by `current.ts`, so it tree-shakes with it.
 */
export function _snapshotCore(state: DraftState): unknown {
  if (state.kind === 'array') {
    const s = state as ArrayState;
    const n = arrLen(s);
    const out = new Array<unknown>(n);
    for (let i = 0; i < n; i++) out[i] = snapshotOf(arrRead(s, i));
    return out;
  }
  const s = state as ObjectState;
  const src = latestObj(s);
  const out: Rec = {};
  for (const key of _recordKeys(src)) _defineRecordField(out, key, snapshotOf(src[key]));
  return out;
}

function describe(target: unknown): string {
  const state = stateOf(target);
  return state !== undefined ? `${state.kind} draft` : Array.isArray(target) ? 'plain array' : typeof target;
}

function navigate(draft: unknown, path: PatchPath): unknown {
  let cur = draft;
  for (const seg of path) {
    const state = stateOf(cur);
    cur =
      state !== undefined && state.childAt !== undefined
        ? state.childAt(state, seg)
        : (cur as Record<PropertyKey, unknown>)[seg as PropertyKey];
  }
  return cur;
}
