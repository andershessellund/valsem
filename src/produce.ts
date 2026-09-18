// ---------------------------------------------------------------------------
// produce — mutate a draft, receive the canonical value.
//
//     const next = produce(state, draft => { draft.count++; });
//     next === intern({ ...state, count: state.count + 1 });   // canonical
//
// Architecture (measured against the immer and mutative sources — see
// DESIGN.md §7 and DECISIONS.md D35–D38):
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

import { ownAt, ownElements, hasHoles } from './shared.js';
import { intern, internHash, _accOf, _internPrehashed } from './intern.js';
import { _entryTerm, _recordHashOf, _arrayHashOf, _elementTerm } from './deep-hash.js';
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
  isImmutable,
  _runInScope,
  _currentScope,
  _setCoreDraftFactories,
  isPlainObject,
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

/**
 * Node's `util.inspect` (so `console.log`, and a debugger's hover) formats a
 * Proxy by reading its TARGET directly, past the traps — for a draft that is
 * the internal state, not the data. Node honours this well-known hook on the
 * target, so both draft targets carry it and print what the draft holds. A
 * registered symbol: nothing is imported, and other runtimes ignore it.
 */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

interface ObjectState extends DraftState<Rec> {
  kind: 'object';
  [INSPECT](): unknown;
  copy: Rec | null;
  /** true = set, false = deleted; absent key = only child-drafted. */
  assigned: Map<string | symbol, boolean> | null;
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
      (stateOf(value) === undefined && isImmutable(value))
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
      // Assigning the original back over its own draft: the child's edits are
      // abandoned and the slot holds `value` again. An ASSIGNMENT (true) —
      // this used to record `false`, the deleted marker, and the patches said
      // `record.delete` for a key the result still had. Finalize compares
      // with the base and emits nothing when the slot nets out.
      prepareObjCopy(state);
      _defineRecordField(state.copy!, prop, value);
      state.assigned!.set(prop, true);
      return true;
    }
    if (same(value, current)) {
      if (value !== undefined || hasOwn(latestObj(state), prop)) return true; // no-op write
      // `d.k = undefined` on an absent key. In record semantics that is no
      // change (undefined IS absent), so the draft is not marked modified —
      // a recipe may still return a replacement. Inside the recipe the key
      // exists, as in plain JS, so it is written; finalize drops it.
      prepareObjCopy(state);
      _defineRecordField(state.copy!, prop, value);
      state.assigned!.set(prop, true);
      return true;
    }
    assertAssignable(value, state);
    prepareObjCopy(state);
    markChanged(state);
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

/** The {@link INSPECT} hook. Node finds it on the target but calls it on the PROXY. */
function inspectDraft(this: unknown): unknown {
  let state: DraftState | undefined;
  try {
    state = stateOf(this);
  } catch {
    return '[revoked valsem draft]'; // a revoked Proxy throws on any access
  }
  if (state?.kind === 'object') return { ...latestObj(state as ObjectState) };
  if (state?.kind === 'array') {
    const arr = state as ArrayState;
    return Array.from({ length: arrLen(arr) }, (_, i) => arrRead(arr, i));
  }
  return this;
}

function createObjectDraft(base: Rec, parent?: DraftState): ObjectState {
  const state = createDraftState<ObjectState>({
    kind: 'object',
    parent,
    base,
    copy: null,
    assigned: null,
    drafted: null,
    draft: null as unknown as object,
    revoke: null as unknown as () => void,
    finalize: finalizeObject,
    [INSPECT]: inspectDraft,
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
  * and dies with its base (the cache law, DESIGN.md §6.4 — O(n) caches must
 * be evictable), and is private to copyArr, never mutated, only sliced.
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

/**
 * The draft's element at `i`, from its OWN content. Every array read here is
 * of a dense array, in range: the working copy is kept dense (growth fills
 * its gap), a base is canonical or was materialized from its own elements at
 * creation, and an index past the end answers `undefined` without touching
 * an array — a plain out-of-range read is a hole read, and a hole reads
 * through to Array.prototype.
 */
function arrRead(state: ArrayState, i: number): unknown {
  if (state.copy !== null) return i < state.copy.length ? state.copy[i] : undefined;
  if (i < state.base.length) {
    return state.vEdits.has(i) ? state.vEdits.get(i) : state.base[i];
  }
  const j = i - state.base.length;
  return j < state.vTail.length ? state.vTail[j] : undefined;
}

/** Is `value` one of the base array's object elements? (Lazily built.) */
function isBaseMember(state: ArrayState, value: unknown): boolean {
  let members = state.baseMembers;
  if (members === null) {
    members = state.baseMembers = new Set();
    for (const el of ownElements(state.base)) {
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

/**
 * Mutating methods captured as intent. push/pop stay virtual; the rest materialize.
 *
 * A NULL-PROTOTYPE table: it is indexed by whatever property the recipe reads,
 * and a plain literal would answer `toString`, `valueOf`, `hasOwnProperty`,
 * `constructor`, `__proto__`… with Object.prototype's members, which the get
 * trap would then wrap as mutating methods — marking the draft modified and
 * calling them with no receiver (`String(draft)` gave "[object Undefined]").
 */
const CAPTURED: Record<string, (state: ArrayState, args: unknown[]) => unknown> = Object.assign(
  Object.create(null) as Record<string, (state: ArrayState, args: unknown[]) => unknown>,
  {
    push(state: ArrayState, args: unknown[]) {
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
  } satisfies Record<string, (state: ArrayState, args: unknown[]) => unknown>,
);

/**
 * The array index `prop` spells, or -1. Canonical spellings only, as in
 * JavaScript: `'1'` is index 1, while `'01'`, `'1.0'` and `'+1'` are ordinary
 * property names that an array does not have.
 */
function arrayIndex(prop: string | symbol): number {
  if (typeof prop !== 'string' || !/^(?:0|[1-9]\d*)$/.test(prop)) return -1;
  const index = Number(prop);
  return index < 0xffffffff ? index : -1;
}

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
    const index = arrayIndex(prop);
    if (index === -1) {
      // Methods and symbols come off Array.prototype; index reads and length
      // during their execution route back through these traps, so iteration
      // and the read-only methods work virtually.
      return Reflect.get(state.copy ?? state.base, prop, state.draft);
    }
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
        (isImmutable(value) || (state.opaqued && isBaseMember(state, value))))
    ) {
      (state.drafted ??= new Set()).add(index);
      const child = createChildDraft(value, state);
      // Store it where arrRead looks: vEdits covers the base region only. A
      // child drafted over a pushed (frozen) element belongs in the tail —
      // parked in vEdits it was never read again, and its edits were lost.
      if (state.copy !== null) state.copy[index] = child;
      else if (index < state.base.length) state.vEdits.set(index, child);
      else state.vTail[index - state.base.length] = child;
      return child;
    }
    return value;
  },
  has(target, prop) {
    const state = (target as [ArrayState])[0]!;
    const index = arrayIndex(prop);
    if (index !== -1) return index < arrLen(state);
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
      const copy = materializeArr(state);
      markChanged(state);
      state.ops = null;
      const from = copy.length;
      copy.length = value as number;
      // Growing `length` makes holes; as a value they are `undefined`, and the
      // copy must say so itself, or finalize would read them off the prototype.
      if (copy.length > from) copy.fill(undefined, from);
      return true;
    }
    const index = arrayIndex(prop);
    if (index === -1) {
      throw new TypeError(`valsem: arrays take integer indices, got ${String(prop)}`);
    }
    const len = arrLen(state);
    const current = index < len ? arrRead(state, index) : undefined;
    if (same(value, current) && index < len) return true;
    assertAssignable(value, state);
    markChanged(state);
    if (index >= len) {
      // Sparse growth: net diff. The gap is filled, not left as holes.
      const copy = materializeArr(state);
      state.ops = null;
      const from = copy.length;
      copy[index] = value;
      copy.fill(undefined, from, index);
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
    // `length` is not configurable on any array; routed through `set` it
    // became `copy.length = undefined`, a RangeError about array lengths.
    if (prop === 'length') throw new TypeError("valsem: cannot delete an array's length");
    return arrayTraps.set!.call(this, target, prop, undefined, (target as [ArrayState])[0]!.draft);
  },
  getOwnPropertyDescriptor(target, prop) {
    const state = (target as [ArrayState])[0]!;
    const index = arrayIndex(prop);
    if (index !== -1) {
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
  // A canonical base is dense. A RAW base may be sparse, and then every read
  // of `base[i]`, and the `slice()` that materializes it, would see the
  // prototype chain at its holes. Such a base starts materialized, from its
  // own elements; the scan is O(n), and so is finalizing any raw base.
  if (_accOf(base) === undefined && hasHoles(base)) state.copy = ownElements(base);
  const target = [state] as [ArrayState] & { [INSPECT]?: () => unknown };
  target[INSPECT] = inspectDraft;
  const { proxy, revoke } = Proxy.revocable(target as unknown as object, arrayTraps);
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

  // Fast path: canonical base with a cached accumulator. Key order is not
  // part of the value, so an added key (which lands at the end of the copy)
  // is just one more accumulator term.
  const accInfo = _accOf(base);
  const fast = accInfo !== undefined;
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
        acc = (acc + _entryTerm(key, internHash(resolved))) >>> 0;
        n++;
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

/**
 * The patch path for the value in a sequence slot, or null when the slot is
 * described by the sequence's own ops. A `home` slot (never assigned) always
 * has one. An ASSIGNED slot has one exactly when it holds a child draft of
 * THIS container: the op captured the value as it was assigned, and the
 * container then drafted it on read (`d[0] = c; d[0].y = 2`), so the edits
 * are in no op. The child says them itself, after the ops, against the final
 * index — its own patches, or a `replace` if an alias finalized it first
 * (see `resolve`). A draft the recipe brought from elsewhere has another
 * parent: the op that placed it already carries its final value.
 */
function slotPath(
  owner: DraftState,
  slot: unknown,
  home: boolean,
  path: PatchPath,
  index: number,
): PatchPath | null {
  if (home) return [...path, index];
  return stateOf(slot)?.parent === owner ? [...path, index] : null;
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
      const slot = arrRead(state, i);
      const resolved = resolve(slot, emitting ? slotPath(state, slot, !assignedIdx.has(i), path!, i) : null, recorder);
      if (same(resolved, base[i])) {
        // Netted out — but a materialized copy holds the child DRAFT at this
        // index (written by the read trap); restore the base value so the
        // built successor cannot embed a revoked proxy.
        if (!virtual) state.copy![i] = base[i];
        continue;
      }
      keys.push(i);
      vals.push(resolved);
      acc = (acc - _elementTerm(i, internHash(base[i])) + _elementTerm(i, internHash(resolved))) | 0;
    }
    // Rewritten region: subtract the base's [low, L), add the final [low, L2).
    // (`low` is derivable as L2 − app.length, so the transition signature
    // stays unambiguous.)
    const app: unknown[] = [];
    for (let i = low; i < L; i++) {
      acc = (acc - _elementTerm(i, internHash(base[i]))) | 0;
    }
    for (let i = low; i < L2; i++) {
      const slot = arrRead(state, i);
      const resolved = resolve(slot, emitting ? slotPath(state, slot, false, path!, i) : null, recorder);
      app.push(resolved);
      acc = (acc + _elementTerm(i, internHash(resolved))) | 0;
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
    // Positions are unstable here, so home and alias slots cannot be told
    // apart: every slot holding a draft gets its path. One finalized by the
    // ops above emits a `replace` — redundant in an alias slot, the only
    // record of the change in its home slot.
    const slot = ownAt(copy, i); // dense by construction; own-only regardless
    const childPath = emitting && opsMode && stateOf(slot) !== undefined ? [...path!, i] : null;
    resolved[i] = resolve(slot, childPath, recorder);
  }
  state.result = intern(resolved);
  if (emitting && opsMode && state.result === base) {
    retractSeqPatches(recorder!, patchMark, opCount);
  }
  if (emitting && !opsMode) {
    // Array.from (not .map): the base may be frozen — see copyArr.
    emitSeqDiff(
      ownElements(state.base).map((v) => intern(v)),
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
 * @internal Whether `T` has a function-typed member. A record never does —
 * functions are not values — so a type with one is a class instance:
 * something `produce` hands out as itself, never drafted member-wise.
 * Symbol-keyed methods (`[equals]`, `[toDraft]`) count, so every value
 * type written against the protocol is caught. An `any` member is not
 * evidence (it would match `Function`), and an optional or nullable
 * function member counts like a plain one.
 */
export type _HasFunctionMember<T> = {
  [K in keyof T]-?: 0 extends 1 & T[K]
    ? never // any: no evidence
    : [NonNullable<T[K]>] extends [never]
      ? never // never / `?: undefined` (the exclusive-union idiom): not a function
      : NonNullable<T[K]> extends Function
        ? true
        : never;
}[keyof T] extends never
  ? false
  : true;

/**
 * The draft twin of a value type — what the recipe receives for `T`.
 *
 * Plain objects and arrays map to their writable shapes; anything that
 * implements `[toDraft]` maps to whatever its draft state's `draft` is
 * (`ValueMap<K, V>` → `DraftMap<K, V>`, and likewise for your own types).
 * Everything else is an opaque leaf and maps to **itself**: `ValueDate`,
 * `InternedString`, `RawArray`, Temporal values, and any class with
 * `[equals]`/`[hashCode]` are handed to the recipe as the canonical value
 * they are, so their methods keep working and their fields stay readonly.
 * Replace such a leaf by assigning a new value into its slot. (The test is
 * "has a method": a record can never contain a function, so a type with one
 * is a class instance. A registered third-party class with data fields only
 * still maps member-wise.)
 */
export type Draft<T> = T extends { [toDraft](parent?: DraftState): { draft: infer D } }
  ? D
  : T extends readonly unknown[]
    ? _IsPlainArray<T> extends true
      ? Draft<T[number]>[]
      : { -readonly [K in keyof T]: Draft<T[K]> }
    : T extends object
      ? _HasFunctionMember<T> extends true
        ? T
        : { -readonly [P in keyof T]: Draft<T[P]> }
      : T;

/**
 * @internal A plain array type (`number[]`, `readonly string[]`) as opposed
 * to a tuple, whose element union would not round-trip — tuples map
 * homomorphically instead (immer's rule).
 */
export type _IsPlainArray<T extends readonly unknown[]> = T extends readonly (infer U)[]
  ? U[] extends T
    ? true
    : false
  : false;

/**
 * The value type a draft type stands for — the inverse of {@link Draft}:
 * `Undraft<DraftMap<K, V>>` is `ValueMap<K, V>`, `Undraft<IntervalDraft>` is
 * `Interval` (read off the draft's `[DRAFT_STATE]`), a plain object or
 * array draft maps back member-wise (in the writable spelling — the state
 * type as most code declares it), and an opaque leaf (a class instance —
 * `ValueDate`, a value type of your own) is itself, as in `Draft<T>`.
 */
export type Undraft<D> = D extends { readonly [DRAFT_STATE]: DraftState<infer B> }
  ? B
  : D extends readonly unknown[]
    ? _IsPlainArray<D> extends true
      ? Undraft<D[number]>[]
      : { [K in keyof D]: Undraft<D[K]> }
    : D extends object
      ? _HasFunctionMember<D> extends true
        ? D
        : { [P in keyof D]: Undraft<D[P]> }
      : D;

/**
 * @internal `T` with every record and array readonly — the shape of a
 * frozen value of `T`. A parameter typed this way accepts a state declared
 * either way (`number[]` or `readonly number[]`), since mutable is
 * assignable to readonly.
 */
export type _Frozen<T> = T extends readonly unknown[]
  ? _IsPlainArray<T> extends true
    ? readonly _Frozen<T[number]>[]
    : { readonly [K in keyof T]: _Frozen<T[K]> }
  : T extends object
    ? _HasFunctionMember<T> extends true
      ? T
      : { readonly [P in keyof T]: _Frozen<T[P]> }
    : T;

/**
 * @internal The producer a curried `produce(recipe)` returns, read off the
 * recipe's own type: the draft parameter names the draft, {@link Undraft}
 * recovers the state, and the base parameter takes the frozen spelling so a
 * state declared either way is accepted. `never` when the recipe's return
 * is not a valid {@link RecipeReturn} for that state.
 */
export type _CurriedFromRecipe<R> = R extends (draft: infer D, ...args: infer A) => infer Ret
  ? Ret extends RecipeReturn<Undraft<D>>
    ? (base: _Frozen<Undraft<D>>, ...args: A) => Undraft<D>
    : never
  : never;

/**
 * What a recipe may return: nothing (it mutated the draft), the draft
 * itself, a replacement value of the state's type, or {@link nothing} —
 * the last only when the state type admits `undefined`, since that is what
 * the result then is. immer's rule, and its typing.
 */
export type RecipeReturn<T> =
  | void
  | undefined
  | T
  | Draft<T>
  | (undefined extends T ? typeof nothing : never);

function runProduce<T>(
  base: T,
  recipe: (draft: Draft<T>) => RecipeReturn<T>,
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
      // A thenable replacement is almost certainly an `async` recipe. `intern`
      // would reject the Promise anyway (no value semantics); this names the
      // actual mistake instead.
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
 * The recipe mutates the draft, or returns a replacement — never both; see
 * {@link RecipeReturn} for what it may return.
 *
 * The curried form `produce(recipe)` returns `(base, ...args) => produce(base,
 * d => recipe(d, ...args))`, with the extra arguments typed from the recipe.
 * Name the state either way, as with immer: an explicit type argument
 * (`produce<Todo>((d) => …)`, or `produce<Todo, [boolean]>((d, done) => …)`
 * with extra arguments) or an annotated draft parameter
 * (`produce((d: Draft<Todo>, done: boolean) => …)`), from which the state
 * type is recovered with {@link Undraft}.
 */
export function produce<T>(base: T, recipe: (draft: Draft<T>) => RecipeReturn<T>): T;
// Curried, from the recipe's own type. Ordered before the explicit form and
// constrained to a function, so `produce<Todo>(…)` — a type argument that is
// not a function — falls through to the explicit overload (immer's layout).
export function produce<R extends (draft: any, ...args: any[]) => unknown>(recipe: R): _CurriedFromRecipe<R>;
export function produce<T, Args extends unknown[] = []>(
  recipe: (draft: Draft<T>, ...args: Args) => RecipeReturn<T>,
): (base: T, ...args: Args) => T;
export function produce<T, Args extends unknown[]>(
  baseOrRecipe: T | ((draft: Draft<T>, ...args: Args) => RecipeReturn<T>),
  recipe?: (draft: Draft<T>) => RecipeReturn<T>,
): T | ((base: T, ...args: Args) => T) {
  if (recipe === undefined) {
    const r = baseOrRecipe as (draft: Draft<T>, ...args: Args) => RecipeReturn<T>;
    // Curried form: extra call arguments flow into the recipe (immer's
    // convention — `setState(produce(toggle, id))` style).
    return (base: T, ...args: Args) => runProduce(base, (d) => r(d, ...args), undefined);
  }
  return runProduce(baseOrRecipe as T, recipe, undefined);
}

/**
 * A **detached** draft of `value`, inside the running recipe: a second root
 * in the same scope, with no location in the recipe's draft. Edit it, then
 * attach it — assign it into the draft, push it, put it in a collection,
 * embed it in a literal, or return it as the replacement — and finalize
 * resolves it to its canonical value where it landed; attached at several
 * places, every place receives the same instance. Left unattached, it is
 * simply dropped. It is revoked with the scope like every other draft.
 *
 * Meant for material the recipe brings in from elsewhere — another store's
 * value, a signal read inside a computed — that needs editing before it
 * has a slot. Material already reachable through the draft needs no
 * `draft()`: reads through the draft hand out child drafts, and an assigned
 * canonical is drafted on read-back. `draft(x)` and `d.k` (with `base.k ===
 * x`) are two independent states over one base: edits to one do not appear
 * in the other.
 *
 * Non-draftables (primitives, opaque value leaves) return themselves, as
 * `Draft<T>` types them. A draft of this scope returns itself.
 *
 * @throws outside a recipe, or given a draft from another `produce()` call.
 */
export function draft<T>(value: T): Draft<T> {
  const scope = _currentScope();
  if (scope === undefined) {
    throw new Error('valsem: draft() can only be called inside a produce() recipe');
  }
  const state = stateOf(value);
  if (state !== undefined) {
    if (state.scope !== scope) {
      throw new Error('valsem: draft() was given a draft from a different produce() call.');
    }
    return value as Draft<T>;
  }
  if (!isDraftable(value)) return value as Draft<T>;
  return draftOf(value).draft as Draft<T>;
}

/**
 * Like {@link produce}, additionally returning the semantic patches that turn
 * `base` into the result and the inverse patches that turn the result back
 * into `base` — all patch values canonical.
 */
export function produceWithPatches<T>(
  base: T,
  recipe: (draft: Draft<T>) => RecipeReturn<T>,
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
    if (p.kind === 'replace' && p.path.length === 0) {
      flush();
      current = intern(p.value);
    } else {
      run.push(p);
    }
  }
  flush();
  return intern(current) as T;
}

/** A copy of `p` with its payload canonical: `value`, and the members of `insert`. */
function internPatch(p: Patch): Patch {
  const loose = p as unknown as { value?: unknown; insert?: unknown };
  const hasValue = 'value' in loose;
  const hasInsert = Array.isArray(loose.insert);
  if (!hasValue && !hasInsert) return p;
  const out = { ...loose };
  if (hasValue) out.value = intern(loose.value);
  // Own elements first: `map` visits an inherited index like any other native walk.
  if (hasInsert) out.insert = ownElements(loose.insert as unknown[]).map((v) => intern(v));
  return out as unknown as Patch;
}

/** A `replace` below the root: the value at `path` becomes `value`. */
function replaceAt(draft: unknown, path: PatchPath, value: unknown): void {
  navigate(draft, path); // validates the whole path, the last segment included
  const parent = navigate(draft, path.slice(0, -1));
  const segment = path[path.length - 1];
  const state = stateOf(parent);
  if (state?.replaceChild !== undefined) state.replaceChild(state, segment, value);
  else if (state !== undefined && (state.kind === 'object' || state.kind === 'array')) {
    (parent as Record<PropertyKey, unknown>)[segment as PropertyKey] = value;
  } else {
    throw new Error(`valsem: cannot apply a 'replace' patch inside a ${describe(parent)}`);
  }
}

/** Apply one run of patches (no root replace among them) to a draft, in order. */
function applyRun(draft: unknown, patches: readonly Patch[]): void {
  for (const raw of patches) {
    // Patch values are interned on application (DESIGN §7.5) — HERE, before
    // they enter the draft, not at finalize. Assigned raw, a caller's object
    // sat in the draft as the recipe's own mutable material, and a later
    // patch that navigated into it wrote into the caller's object.
    const p = internPatch(raw);
    if (p.kind === 'replace') {
      replaceAt(draft, p.path, p.value);
      continue;
    }
    const target = navigate(draft, p.path);
    const state = stateOf(target);
    if (state !== undefined && state.applyPatch !== undefined) {
      state.applyPatch(state, p); // a draftable kind applies its own patches
      continue;
    }
    switch (p.kind) {
      case 'record.set':
        // Define semantics on raw targets too: a `__proto__` key must become an
        // own property, never a prototype change. (A draft's set trap does the same.)
        if (typeof p.key !== 'string' && typeof p.key !== 'symbol') throw badPatch(p.kind, 'a string or symbol key');
        if (state !== undefined) (target as Rec)[p.key] = p.value;
        else _defineRecordField(target as Rec, p.key, p.value);
        break;
      case 'record.delete':
        if (typeof p.key !== 'string' && typeof p.key !== 'symbol') throw badPatch(p.kind, 'a string or symbol key');
        delete (target as Rec)[p.key];
        break;
      case 'list.set':
        if (!Number.isInteger(p.index) || p.index < 0) throw badPatch(p.kind, 'an integer index');
        (target as unknown[])[p.index] = p.value;
        break;
      case 'list.splice':
        if (!Number.isInteger(p.index) || p.index < 0 || !Number.isInteger(p.remove) || p.remove < 0 || !Array.isArray(p.insert)) {
          throw badPatch(p.kind, 'integer index and remove counts and an insert array');
        }
        (target as unknown[]).splice(p.index, p.remove, ...ownElements(p.insert as unknown[]));
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

function badPatch(kind: string, expected: string): Error {
  return new Error(`valsem: malformed '${kind}' patch — expected ${expected}`);
}

function describe(target: unknown): string {
  const state = stateOf(target);
  return state !== undefined ? `${state.kind} draft` : Array.isArray(target) ? 'plain array' : typeof target;
}

/**
 * Walk a patch path. Patches may come from anywhere (a wire, a store), so
 * every segment is validated against the thing it addresses: a record
 * segment must be an OWN key of the record (never a prototype read — the
 * route to `Object.prototype` through `__proto__` or `constructor`), an
 * array segment an integer index in range, and a draftable kind routes
 * through its own `childAt`. Anything else is a bad path, not a lookup.
 */
function navigate(draft: unknown, path: PatchPath): unknown {
  let cur = draft;
  for (const seg of path) {
    const state = stateOf(cur);
    if (state !== undefined && state.childAt !== undefined) {
      cur = state.childAt(state, seg);
      continue;
    }
    if (state !== undefined && state.kind === 'array') {
      const len = arrLen(state as ArrayState);
      if (!Number.isInteger(seg) || (seg as number) < 0 || (seg as number) >= len) throw badPath(seg);
      cur = (cur as unknown[])[seg as number];
    } else if (state !== undefined && state.kind === 'object') {
      if ((typeof seg !== 'string' && typeof seg !== 'symbol') || !hasOwn(latestObj(state as ObjectState), seg)) {
        throw badPath(seg);
      }
      cur = (cur as Rec)[seg];
    } else if (Array.isArray(cur)) {
      if (!Number.isInteger(seg) || (seg as number) < 0 || (seg as number) >= cur.length) throw badPath(seg);
      cur = cur[seg as number];
    } else if (isPlainObject(cur)) {
      if ((typeof seg !== 'string' && typeof seg !== 'symbol') || !hasOwn(cur, seg)) throw badPath(seg);
      cur = (cur as Rec)[seg];
    } else {
      throw badPath(seg);
    }
  }
  return cur;
}

function badPath(seg: unknown): Error {
  return new Error(`valsem: patch path segment ${String(seg)} does not address an own key or index of the value`);
}
