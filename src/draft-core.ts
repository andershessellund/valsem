// ---------------------------------------------------------------------------
// draft-core — the machinery every draft kind shares, and the protocol that
// lets any type be drafted by produce.
//
// produce's records and arrays, the built-in collections (ValueMap/ValueSet/
// ValueList), and third-party types all plug in the same way: a value's
// prototype implements `[toDraft](parent)` and returns a DraftState built
// with `createDraftState`. The state carries the draft handed to the recipe,
// a `finalize` that turns the state back into a canonical value (emitting
// patches), and optionally `applyPatch`/`childAt` so `applyPatches` can
// route through it. produce itself knows only plain objects and arrays; it
// registers those two kinds here at import, and everything else arrives
// through the protocol — which is what keeps a produce-only bundle free of
// the collection code, and a ValueMap-only bundle free of produce.
//
// This module is the public surface of `valsem/draft`.
// ---------------------------------------------------------------------------

import { intern, _hashCacheHas } from './intern.js';
import { _depthError, _maxDepth } from './limits.js';
import { interned as internedMarker, _defineRecordField } from './deep-equal.js';

/**
 * Symbol under which a draftable type exposes its draft factory.
 *
 * Implement `[toDraft](parent)` on a class to let `produce` hand out a
 * mutable draft of its instances. The method builds a {@link DraftState}
 * with {@link createDraftState} and returns it: `state.draft` is what the
 * recipe receives, and `state.finalize` turns the state back into the
 * canonical result. `Draft<T>` infers the draft type from this method's
 * return type. A global-registry symbol, versioned like the other protocol
 * symbols, so a copy of valsem only reads the protocol it understands.
 */
export const toDraft: unique symbol = Symbol.for('valsem.toDraft.v1') as any;

/** @internal The property through which a draft object exposes its state. */
export const DRAFT_STATE: unique symbol = Symbol('valsem.draftState') as any;

// ---------------------------------------------------------------------------
// Patch vocabulary
// ---------------------------------------------------------------------------

/**
 * Path from the root to the container a patch operates on. Segments are
 * record keys (string), sequence indices (number), or — under a map — the
 * canonical key value itself.
 */
export type PatchPath = readonly unknown[];

/**
 * The patch kinds, keyed by `kind`. A draftable type that emits its own
 * patches adds them by declaration merging, and gets exact narrowing:
 *
 * ```ts
 * declare module 'valsem/draft' {
 *   interface PatchKinds {
 *     'interval.set': { kind: 'interval.set'; path: PatchPath; lo: number; hi: number };
 *   }
 * }
 * ```
 */
export interface PatchKinds {
  replace: { kind: 'replace'; path: PatchPath; value: unknown };
  'record.set': { kind: 'record.set'; path: PatchPath; key: string; value: unknown };
  'record.delete': { kind: 'record.delete'; path: PatchPath; key: string };
  'list.set': { kind: 'list.set'; path: PatchPath; index: number; value: unknown };
  'list.splice': {
    kind: 'list.splice';
    path: PatchPath;
    index: number;
    remove: number;
    insert: readonly unknown[];
  };
  'map.set': { kind: 'map.set'; path: PatchPath; key: unknown; value: unknown };
  'map.delete': { kind: 'map.delete'; path: PatchPath; key: unknown };
  'set.add': { kind: 'set.add'; path: PatchPath; value: unknown };
  'set.delete': { kind: 'set.delete'; path: PatchPath; value: unknown };
}

/** A semantic patch — one of {@link PatchKinds}. */
export type Patch = PatchKinds[keyof PatchKinds];

/** Where a finalize records this container's patches (forward) and their inverses. */
export interface PatchRecorder {
  patches: Patch[];
  inverse: Patch[];
}

// ---------------------------------------------------------------------------
// Scope and draft states
// ---------------------------------------------------------------------------

/** One produce() call: every draft state it created, all revoked when it ends. */
export interface Scope {
  readonly parent: Scope | undefined;
  readonly states: DraftState[];
}

let currentScope: Scope | undefined;

/** @internal Run `body` inside a fresh scope; every draft it creates is revoked afterwards. */
export function _runInScope<T>(body: () => T): T {
  const scope: Scope = { parent: currentScope, states: [] };
  currentScope = scope;
  try {
    return body();
  } finally {
    for (const s of scope.states) {
      s.revoked = true;
      s.revoke?.();
    }
    currentScope = scope.parent;
  }
}

/**
 * The state produce keeps for one drafted value. A kind extends it with its
 * own bookkeeping; these fields are what the core reads and writes.
 */
export interface DraftState<B = unknown> {
  /** A short tag for the kind (`'object'`, `'array'`, `'map'`, …). Diagnostic only. */
  readonly kind: string;
  readonly base: B;
  readonly parent: DraftState | undefined;
  readonly scope: Scope;
  /** True once anything at or below this state changed; bubbles to the root via {@link markChanged}. */
  modified: boolean;
  /** Memoized finalize result — aliased drafts converge on one canonical. */
  result: unknown;
  finalized: boolean;
  revoked: boolean;
  /** What the recipe receives. */
  draft: unknown;
  /**
   * Turn the state into the canonical result. Only called when `modified`.
   * `path` is null when patches are not wanted for this container (no
   * recorder, or the value was assigned as a whole and is patched by its
   * parent); otherwise emit this container's own patches into `recorder`,
   * resolving children with paths of `[...path, key]`.
   */
  finalize(state: DraftState<B>, path: PatchPath | null, recorder: PatchRecorder | undefined): unknown;
  /** Revoke the draft's access once the recipe ends (proxies do; classes need not). */
  revoke?(): void;
  /** Apply one of this kind's patches to the live draft — how {@link applyPatches} reaches it. */
  applyPatch?(state: DraftState<B>, patch: Patch): void;
  /** The child under `segment` of the live draft — how {@link applyPatches} navigates through it. */
  childAt?(state: DraftState<B>, segment: unknown): unknown;
  /**
   * The value as it stands right now — how `current()` reads a draft. Only
   * called when `modified`. Build it from your bookkeeping WITHOUT touching
   * the state (the recipe goes on afterwards), replacing nested values with
   * {@link snapshotOf} of them. It need not be canonical: `current()` interns
   * what you return. Kinds that omit it do not support `current()`.
   */
  snapshot?(state: DraftState<B>): unknown;
}

type DraftStateInit<S extends DraftState> = Omit<S, 'scope' | 'modified' | 'result' | 'finalized' | 'revoked'>;

/**
 * Build a draft state for the running `produce()` and register it with that
 * call's scope, so it is revoked when the recipe returns. Supply your kind's
 * fields plus `finalize`; assign `state.draft` afterwards when the draft
 * object needs the state to construct.
 *
 * @throws if called outside a `produce()` recipe.
 */
export function createDraftState<S extends DraftState>(fields: DraftStateInit<S>): S {
  const scope = fields.parent ? fields.parent.scope : currentScope;
  if (scope === undefined) {
    throw new Error('valsem: drafts can only be created inside a produce() recipe');
  }
  const state = {
    ...fields,
    scope,
    modified: false,
    result: undefined,
    finalized: false,
    revoked: false,
  } as unknown as S;
  scope.states.push(state);
  return state;
}

export type SeqOp =
  | { t: 'set'; i: number; value: unknown; old: unknown }
  | { t: 'splice'; i: number; rc: number; inserted: unknown[]; removed: unknown[] };

/** @internal The draft state behind `value`, if it is a draft. */
export function stateOf(value: unknown): DraftState | undefined {
  return value !== null && typeof value === 'object'
    ? ((value as Record<symbol, unknown>)[DRAFT_STATE] as DraftState | undefined)
    : undefined;
}

/** Whether `value` is a valsem draft (proxy or collection draft). */

export function isDraft(value: unknown): boolean {
  return stateOf(value) !== undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Values produce hands out as drafts. */

// The two built-in kinds live in produce.ts, which registers them here at
// import — so this module never depends on the proxy machinery.
type CoreFactory<B> = (base: B, parent?: DraftState) => DraftState<B>;
let coreObject: CoreFactory<Record<string, unknown>> | null = null;
let coreArray: CoreFactory<unknown[]> | null = null;

/** @internal Called once by produce.ts. */
export function _setCoreDraftFactories(
  object: CoreFactory<Record<string, unknown>>,
  array: CoreFactory<unknown[]>,
): void {
  coreObject = object;
  coreArray = array;
}

/** Whether produce would hand `v` out as a draft: a plain object, an array, or a `[toDraft]` implementer. */
export function isDraftable(v: unknown): boolean {
  return (
    isPlainObject(v) ||
    Array.isArray(v) ||
    (v !== null && typeof v === 'object' && typeof (v as Record<symbol, unknown>)[toDraft] === 'function')
  );
}

/** The draft state for a draftable `value`, under `parent` (or at the root). */
export function draftOf(value: unknown, parent?: DraftState): DraftState {
  if (isPlainObject(value)) return coreObject!(value, parent);
  if (Array.isArray(value)) return coreArray!(value, parent);
  return (value as { [toDraft](parent?: DraftState): DraftState })[toDraft](parent);
}

/** Draft a child value; returns the draft object to hand to the recipe. */
export function createChildDraft(value: unknown, parent: DraftState): unknown {
  return draftOf(value, parent).draft;
}

/** Mark `state` and every ancestor as changed. */
export function markChanged(state: DraftState): void {
  if (!state.modified) {
    state.modified = true;
    if (state.parent) markChanged(state.parent);
  }
}

/** Throw the teaching error if the draft escaped its produce() call. */
export function assertUnrevoked(state: DraftState): void {
  if (state.revoked) {
    throw new Error(
      'valsem: this draft escaped its produce() call and can no longer be used. ' +
        'Drafts are only valid inside the recipe.',
    );
  }
}

/** Throw if `value` is a draft that belongs to a different produce() call. */
export function assertAssignable(value: unknown, into: DraftState): void {
  const vState = stateOf(value);
  if (vState !== undefined && vState.scope !== into.scope) {
    throw new Error('valsem: cannot assign a draft from a different produce() call.');
  }
}

// ---------------------------------------------------------------------------
// Finalize — the intern walk
// ---------------------------------------------------------------------------

/**
 * Resolve any value reachable from a draft to its canonical form: drafts
 * finalize (memoized); canonical values pass in O(1); foreign material
 * adopts — walked once for embedded drafts, then interned.
 */
export function resolve(
  value: unknown,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const state = stateOf(value);
  if (state !== undefined) return finalizeState(state, path, recorder);
  return adopt(value);
}

/** Restore-side value for inverse patches: a draft restores its base. */

export function restoreValue(value: unknown): unknown {
  const state = stateOf(value);
  if (state !== undefined) return intern(state.base);
  return intern(value);
}

// ---------------------------------------------------------------------------
// Snapshots — current()'s non-finalizing read of a draft
// ---------------------------------------------------------------------------

let coreSnapshot: ((state: DraftState) => unknown) | undefined;

/** @internal `current()` registers the plain object/array snapshots here, so `produce` bundles without them. */
export function _setCoreSnapshot(fn: (state: DraftState) => unknown): void {
  coreSnapshot = fn;
}

/**
 * The value `value` stands for right now: a draft becomes its current
 * contents (its base when unmodified, otherwise the kind's {@link DraftState.snapshot}),
 * foreign plain data is walked for embedded drafts, and everything else is
 * returned as-is. Nothing is finalized or interned — the draft stays live.
 * Kinds call this on their children when implementing `snapshot`.
 */
export function snapshotOf(value: unknown): unknown {
  const state = stateOf(value);
  if (state === undefined) return snapshotForeign(value);
  assertUnrevoked(state);
  if (!state.modified) return state.base;
  if (state.snapshot !== undefined) return state.snapshot(state);
  if (coreSnapshot !== undefined && (state.kind === 'object' || state.kind === 'array')) {
    return coreSnapshot(state);
  }
  throw new Error(
    `valsem: current() is not supported for a '${state.kind}' draft — its draft state has no snapshot()`,
  );
}

let snapshotDepth = 0;

/** Foreign material assigned into a draft may embed drafts: rebuild it with those snapshotted. */
function snapshotForeign(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ((value as Record<symbol, unknown>)[internedMarker] === true || _hashCacheHas(value)) {
    return value; // canonical: cannot contain a draft
  }
  snapshotDepth++;
  try {
    if (snapshotDepth > _maxDepth()) throw _depthError('current');
    if (isPlainObject(value)) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const child = value[key];
        const snap = snapshotOf(child);
        if (snap !== child) changed = true;
        _defineRecordField(out, key, snap);
      }
      return changed ? out : value;
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = new Array<unknown>(value.length);
      for (let i = 0; i < value.length; i++) {
        const snap = snapshotOf(value[i]);
        if (snap !== value[i]) changed = true;
        out[i] = snap;
      }
      return changed ? out : value;
    }
    return value;
  } finally {
    snapshotDepth--;
  }
}

let adoptDepth = 0;

/** Intern foreign material, finalizing any drafts embedded in it. */

export function adopt(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // O(1) recognition of canonical material: the [interned] marker covers the
  // collections and pooled value types; the hash cache covers canonical
  // plain data.
  if ((value as Record<symbol, unknown>)[internedMarker] === true || _hashCacheHas(value)) {
    return value;
  }
  // Same decode-boundary depth cap as intern: adopt recurses over foreign
  // material a recipe grafted in, which can be hostile or cyclic.
  adoptDepth++; // inside the try's reach: the cap throw must unwind it too
  try {
    if (adoptDepth > _maxDepth()) throw _depthError('produce');
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
      if (resolved !== undefined) _defineRecordField(out, key, resolved);
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

/** Finalize a draft state (memoized): unchanged states intern their base; changed ones delegate to the kind. */
export function finalizeState(
  state: DraftState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  if (state.finalized) return state.result;
  state.finalized = true;
  if (!state.modified) {
    state.result = intern(state.base);
    return state.result;
  }
  return state.finalize(state, path, recorder);
}

// ---------------------------------------------------------------------------
// Sequence patches — shared by arrays and lists
// ---------------------------------------------------------------------------

export function emitSeqOps(ops: SeqOp[], path: PatchPath, recorder: PatchRecorder): void {
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
export function retractSeqPatches(
  recorder: PatchRecorder,
  patchMark: number,
  inverseCount: number,
): void {
  recorder.patches.length = patchMark;
  recorder.inverse.splice(0, inverseCount);
}

/** Net index diff plus one tail splice — the intent-lost patch fallback. */

/**
 * If every op is a positional set or a tail splice, positions BELOW the
 * low-water mark are stable: return the assigned indices, the final length,
 * and `low` — the minimum length reached. Everything at index ≥ low was
 * rewritten by the tail-splice sequence (pop-then-push changes content at
 * indices below the base length without changing the length!) and must be
 * taken from the final items, not delta'd. Mid-sequence splices → null.
 */
export function seqTailProfile(
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
