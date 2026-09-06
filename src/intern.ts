// ---------------------------------------------------------------------------
// Interner — global structural deduplication with weak references
//
// `intern(value)` returns a canonical copy such that:
//   1. Structural equality → reference equality (===)
//   2. Hash code is precomputed and cached in a WeakMap (O(1) deepHash)
//   3. The interner does NOT hold strong references — canonical copies may
//      be garbage-collected when no other references exist; their pool
//      metadata is then reclaimed in idle time (see intern-pool.ts for the
//      design and its measured rationale).
//
// Supported value types: primitives (returned as-is), plain objects, arrays,
// and any type registered as `{ immutable: true }` via `deepEqual.register`
// (Temporal, via `valsem/temporal`, and consumer value types).
//
// Everything else passes through unchanged. Mutability is the reason: a pooled
// instance is shared by every holder, so one mutation would corrupt all of them
// *and* invalidate the hash cached against it. valsem does not treat the mutable
// built-ins (`Date`, `RegExp`, `Map`, `Set`) as values at all — `deepHash` and
// `encode` reject them, naming the immutable replacement.
// ---------------------------------------------------------------------------

import { deepHash, _deepHashWithAcc, _metaOf, _setMeta, _entryTerm, _recordHashOf } from './deep-hash.js';
import {
  interned as internedSym,
  _equalsMethods,
  _immutableTypes,
  _mutableBuiltinReason,
  _setCanonicalProbe, _recordKeys, _defineRecordField } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { _depthError, _maxDepth } from './limits.js';
import { _checking, _freeze } from './checks.js';

// ---------------------------------------------------------------------------
// Shared precomputed hash cache
// ---------------------------------------------------------------------------

// The canonical meta store (hash + accumulator per canonical object) is the
// hasher's — see deep-hash's `_metaOf`/`_setMeta`.

// Wire it into deepHash so internalized children are hashed in O(1), and into
// deepEqual as the canonicality probe (distinct canonicals are unequal in O(1)).
_setCanonicalProbe((obj) => _metaOf(obj) !== undefined);

// ---------------------------------------------------------------------------
// Pool — the global weak pool
// ---------------------------------------------------------------------------

const pool = createInternPool<object>();

// ---------------------------------------------------------------------------
// Public lookup helpers
// ---------------------------------------------------------------------------

/**
 * Whether `value` is in canonical form — the form in which `===` IS value
 * equality: a primitive (symbols included; functions are not values), or an
 * object valsem canonicalised (the collections and pooled value types by
 * their marker, plain data by the hash cache). This is the probe every walk
 * uses to stop at a canonical boundary, exposed for boundary assertions and
 * comparators of your own.
 */
export function isCanonical(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  return (value as Record<symbol, unknown>)[internedSym] === true || _metaOf(value) !== undefined;
}

function describeNonCanonical(value: unknown): string {
  if (typeof value === 'function') return 'a function';
  if (Array.isArray(value)) return 'a raw array';
  const ctor = (value as object).constructor as { name?: string } | undefined;
  return ctor === undefined || ctor === Object ? 'a raw object' : `an instance of ${ctor.name ?? 'an unregistered class'}`;
}

/**
 * Equality by identity, for canonical values — `a === b`, which is value
 * equality once both sides are canonical. Unlike `deepEqual`, it never
 * walks: the promise that both arguments are canonical (or primitive) is
 * yours, and while checks are on it is verified, throwing on a raw object
 * (whose `===` would be a silent `false`). `skipChecks()` turns the check
 * off; the comparison is then a bare `===`.
 */
export function fastEquals(a: unknown, b: unknown): boolean {
  if (_checking()) {
    if (!isCanonical(a)) throw nonCanonical('first', a);
    if (!isCanonical(b)) throw nonCanonical('second', b);
  }
  return a === b;
}

function nonCanonical(which: string, value: unknown): TypeError {
  return new TypeError(
    `valsem: fastEquals() compares canonical values by identity, but its ${which} argument is ${describeNonCanonical(value)}. ` +
      'Intern it first (intern(), produce(), or a collection), or use deepEqual(). skipChecks() disables this check.',
  );
}

/**
 * Structural hash of `value`, reusing the intern cache when possible.
 *
 * Equivalent to {@link deepHash} for the same input, but when `value` is an
 * interned object its precomputed hash is returned in O(1) rather than
 * recomputed. Primitives fall through to {@link deepHash}.
 */
export function internHash(value: unknown): number {
  if (value === null || value === undefined || typeof value !== 'object') {
    return deepHash(value);
  }
  const meta = _metaOf(value as object);
  if (meta !== undefined) return meta.h;
  return deepHash(value);
}

// `internEqual` used to live here — deleted. It was a side-effecting
// predicate (its fallback interned both arguments: freezing the caller's
// objects and pooling transients an equality check cannot retain), and its
// fast paths are exactly what `deepEqual`'s canonical short-circuit now does
// without side effects. Callers who WANT adoption semantics say it plainly:
// `intern(a) === intern(b)`.

// ---------------------------------------------------------------------------
// intern() — global, recursive, weak-pooled
// ---------------------------------------------------------------------------

/**
 * Internalize a value. Returns the canonical (deduplicated) copy.
 *
 * - Primitives are returned as-is.
 * - Arrays: elements are internalized first, then the array itself.
 * - Plain objects: values are internalized first (keys kept in the order
 *   ordering), then the object itself.
 * - Already-interned objects (present in the hash cache) are returned
 *   immediately.
 * - Types registered with `{ immutable: true }` (Temporal via
 *   `valsem/temporal`, plus consumer value types) are pooled by their
 *   registered equality handler, unfrozen.
 * - The mutable built-ins `Date`, `RegExp`, `Map`, and `Set` throw, naming the
 *   immutable replacement.
 * - Everything else (unregistered class instances) passes through unchanged,
 *   because pooling a mutable instance would let one mutation corrupt every
 *   holder and invalidate its cached hash.
 */
let depth = 0;

export function intern<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  const obj = value as object;

  // Persistent collections / opt-in classes mark themselves canonical.
  if ((obj as any)[internedSym] === true) return value;

  // Already interned via the legacy WeakMap path — fast path.
  if (_metaOf(obj) !== undefined) return value;

  // Array — internalize elements first. (Depth-capped: this recursion is
  // the decode boundary where hostile or cyclic input would otherwise
  // exhaust the stack.)
  if (Array.isArray(obj)) {
    depth++; // inside the try's reach: the cap throw must unwind it too
    try {
      if (depth > _maxDepth()) throw _depthError('intern');
      const internalized = obj.map(intern);
      return lookupOrStore(internalized, (c) => shallowRefEqual(c, internalized), true) as T;
    } finally {
      depth--;
    }
  }

  // Plain object — internalize values; the layout is the incoming key order.
  // Keys mapped to `undefined` are dropped: an undefined-valued key IS an
  // absent key in record semantics, and the canonical form makes that literal.
  const proto = Object.getPrototypeOf(obj);
  if (proto === Object.prototype || proto === null) {
    depth++;
    try {
      if (depth > _maxDepth()) throw _depthError('intern');
      const rec = obj as Record<string | symbol, unknown>;
      // Layout: the incoming key order (string keys, then symbol keys). Key
      // order is not part of the value — equality and the hash ignore it, and
      // the pool matches by key — so the first spelling seen sets the frozen
      // copy's property order, and a copy built in the raw object's own order
      // shares its hidden class. Sorting would cost ~280 ns per record and
      // force produce onto a slow path whenever a recipe adds a key.
      const keys = _recordKeys(rec);
      // Intern the children and fold the record hash from (key, child) pairs
      // WITHOUT building the canonical copy: on a pool hit — every refetch of
      // unchanged data — the copy would be thrown away. The pool candidate is
      // matched by key against the interned children.
      const n0 = keys.length;
      const vals = new Array<unknown>(n0);
      let acc = 0;
      let n = 0;
      for (let i = 0; i < n0; i++) {
        const v = rec[keys[i]!];
        if (v === undefined) continue; // absent in record semantics
        const c = intern(v);
        vals[i] = c;
        acc = (acc + _entryTerm(keys[i]!, internHash(c))) >>> 0;
        n++;
      }
      const h = _recordHashOf(n, acc);
      const existing = pool.lookup(h, (c) => matchesRecord(c, keys, vals, n));
      if (existing !== undefined) return existing as T;
      const internalized = buildRecord(keys, vals, n);
      _setMeta(internalized, h, acc, n);
      _freeze(internalized);
      return pool.register(internalized, h) as T;
    } finally {
      depth--;
    }
  }

  // Types registered as immutable are pooled by their own equality handler.
  // They are NOT frozen: they are already immutable by contract, and freezing a
  // foreign type can break it (freezing a RegExp makes `lastIndex` read-only,
  // which makes `.exec()` throw on a global pattern).
  const ctor = obj.constructor as Function | undefined;
  if (ctor !== undefined && _immutableTypes.has(ctor)) {
    const eq = _equalsMethods.get(ctor)!;
    return lookupOrStore(
      obj,
      (candidate) => candidate.constructor === ctor && eq(candidate, obj),
      false,
    ) as T;
  }

  // The mutable built-ins are rejected rather than passed through: passing a
  // Date through silently would let `HashMap` key by reference and miss every
  // structurally equal lookup, which is the silent wrong answer this package
  // exists to avoid. Nested ones already throw from deepHash; this covers the
  // top-level case so both fail the same way.
  const reason = _mutableBuiltinReason(ctor);
  if (reason !== undefined) {
    throw new TypeError(
      `intern: ${ctor!.name} cannot be interned — valsem gives value semantics to ` +
        `immutable values only, and ${reason}.`,
    );
  }

  // Everything else (unregistered class instances) — as-is.
  return value;
}

/** Widest record built by assignment: V8 keeps such objects in fast mode well past this (measured: dictionary mode at 20). */
const ASSIGN_MAX_KEYS = 16;

/**
 * The canonical copy of a record from its keys and already-interned children
 * (`vals[i]` undefined = absent). Narrow records are built by assignment —
 * ~10 ns per key, and the copy shares the raw object's hidden class when the
 * key order matches; wide ones by Object.fromEntries, which stays in fast
 * mode at any width (assignment flips to dictionary mode at ~20 keys). Both
 * define `__proto__` as an own data property, the record semantics we want.
 */
function buildRecord(
  keys: (string | symbol)[],
  vals: unknown[],
  n: number,
): Record<string | symbol, unknown> {
  if (n <= ASSIGN_MAX_KEYS) {
    const out: Record<string | symbol, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      if (vals[i] !== undefined) _defineRecordField(out, keys[i]!, vals[i]);
    }
    return out;
  }
  const entries: [string | symbol, unknown][] = [];
  for (let i = 0; i < keys.length; i++) {
    if (vals[i] !== undefined) entries.push([keys[i]!, vals[i]]);
  }
  return Object.fromEntries(entries);
}

/**
 * Does pool candidate `c` hold exactly these (key, canonical child) pairs?
 * Children are canonical, so identity decides — SameValueZero, because a
 * NaN child is canonical too and `NaN !== NaN`.
 */
function matchesRecord(c: object, keys: (string | symbol)[], vals: unknown[], n: number): boolean {
  const meta = _metaOf(c);
  if (meta === undefined || meta.n !== n) return false;
  const proto = Object.getPrototypeOf(c);
  if (proto !== Object.prototype && proto !== null) return false;
  const rc = c as Record<string | symbol, unknown>;
  for (let i = 0; i < keys.length; i++) {
    const v = vals[i];
    if (v === undefined) continue;
    const w = rc[keys[i]!];
    if (w !== v && !(w !== w && v !== v)) return false;
  }
  return true;
}

/**
 * Find the canonical instance matching `obj` in the weak pool, or adopt `obj`
 * as canonical.
 *
 * @param matches - Structural comparison against a pooled candidate. Buckets
 * are shared across every interned kind, so this must also reject candidates of
 * a different kind that merely collided on the hash.
 * @param freeze - Whether to freeze `obj` when it becomes canonical. True for
 * the plain objects and arrays valsem builds itself; false for registered
 * immutable types, which are immutable by contract and may not tolerate it.
 */
function lookupOrStore(
  obj: object,
  matches: (candidate: object) => boolean,
  freeze: boolean,
): object {
  // `freeze` ⟺ plain data valsem builds itself — capture the accumulator so
  // successors of this canonical value hash incrementally.
  if (freeze) {
    const { h, acc, n } = _deepHashWithAcc(obj);
    const existing = pool.lookup(h, matches);
    if (existing !== undefined) return existing;
    _setMeta(obj, h, acc, n);
    _freeze(obj);
    return pool.register(obj, h);
  }
  const h = deepHash(obj);
  const existing = pool.lookup(h, matches);
  if (existing !== undefined) return existing;
  _setMeta(obj, h, 0, -1);
  return pool.register(obj, h);
}

// ---------------------------------------------------------------------------
// Back-compat — deprecated factory wrapper
// ---------------------------------------------------------------------------

/**
 * @deprecated Use the global {@link intern} function instead. Returned
 * object delegates to the global pool; per-instance pools are no longer
 * supported (a single weak pool serves all callers).
 */
export function createInterner(): { intern: typeof intern } {
  return { intern };
}

// ---------------------------------------------------------------------------
// Shallow reference equality — compares structure using === on children
// ---------------------------------------------------------------------------

/** SameValueZero on interned children: `===` plus NaN equals NaN. Children
 * are already canonical, so reference equality is value equality — except for
 * NaN, which `!==` itself and would forever split the pool without this. */
function childEqual(x: unknown, y: unknown): boolean {
  return x === y || (x !== x && y !== y);
}

function shallowRefEqual(a: object, b: object): boolean {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!childEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  if (protoA !== protoB) return false;

  // By key, not by index: canonical layouts follow whichever spelling came
  // first, so two equal records may order their keys differently.
  const ra = a as Record<string | symbol, unknown>;
  const rb = b as Record<string | symbol, unknown>;
  const keysA = _recordKeys(ra);
  if (keysA.length !== _recordKeys(rb).length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]!;
    if (!Object.prototype.hasOwnProperty.call(rb, k)) return false;
    if (!childEqual(ra[k], rb[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test-only inspection (not exported from the package barrel)
// ---------------------------------------------------------------------------

/** @internal Live pool size — exposed for tests. */
export function _internPoolSize(): number {
  return pool.size();
}

/** @internal O(1) probe: is this object canonical plain data (hash cached)? */
export function _hashCacheHas(obj: object): boolean {
  return _metaOf(obj) !== undefined;
}

/** @internal The cached accumulator of a canonical plain record/array. */
export function _accOf(obj: object): { a: number; n: number } | undefined {
  const m = _metaOf(obj);
  return m !== undefined && m.n >= 0 ? m : undefined;
}

/**
 * @internal Canonicalize plain data whose hash and accumulator were computed
 * incrementally (produce's finalize fast path). The caller guarantees: `obj`
 * is in canonical form (records: no undefined values, any key order; children
 * all canonical) and `h`/`acc`/`n` are exactly what `_deepHashWithAcc(obj)`
 * would return.
 */
export function _internPrehashed(obj: object, h: number, acc: number, n: number): object {
  const existing = pool.lookup(h, (c) => shallowRefEqual(c, obj));
  if (existing !== undefined) return existing;
  _setMeta(obj, h, acc, n);
  _freeze(obj);
  return pool.register(obj, h);
}
