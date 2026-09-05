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

import { deepHash, _deepHashWithAcc, _compareSymbols, _hashCache as hashCache } from './deep-hash.js';
import {
  interned as internedSym,
  _equalsMethods,
  _immutableTypes,
  _mutableBuiltinReason,
  _setCanonicals, _recordKeys } from './deep-equal.js';
import { createInternPool } from './intern-pool.js';
import { _depthError, _maxDepth } from './limits.js';

// ---------------------------------------------------------------------------
// Shared precomputed hash cache
// ---------------------------------------------------------------------------

// The hash cache (interned object → its precomputed deepHash) is the hasher's
// own `_hashCache`, imported above: one map for canonical objects and unique
// symbols alike.

/**
 * WeakMap from canonical plain record/array → its raw hash accumulator and
 * defined-entry count (see deep-hash's accumulator contract). Lets produce's
 * finalize compute a successor's hash in O(changes) instead of O(width).
 */
const accCache = new WeakMap<object, { a: number; n: number }>();

// Wire it into deepHash so internalized children are hashed in O(1), and into
// deepEqual as the canonicality probe (distinct canonicals are unequal in O(1)).
_setCanonicals(hashCache);

// ---------------------------------------------------------------------------
// Pool — the global weak pool
// ---------------------------------------------------------------------------

const pool = createInternPool<object>();

// ---------------------------------------------------------------------------
// Public lookup helpers
// ---------------------------------------------------------------------------

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
  const cached = hashCache.get(value as object);
  if (cached !== undefined) return cached;
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
 * - Plain objects: values are internalized first (keys sorted for canonical
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
  if (hashCache.has(obj)) return value;

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

  // Plain object — internalize values, sorted keys for canonical layout.
  // Keys mapped to `undefined` are dropped: an undefined-valued key IS an
  // absent key in record semantics, and the canonical form makes that literal.
  const proto = Object.getPrototypeOf(obj);
  if (proto === Object.prototype || proto === null) {
    depth++;
    try {
      if (depth > _maxDepth()) throw _depthError('intern');
      const rec = obj as Record<string | symbol, unknown>;
      // Canonical layout: string keys sorted, then symbol keys in their
      // total order (registered by name, unique by hash). Only this frozen
      // copy's property order depends on it — the hash and equality do not.
      const keys: (string | symbol)[] = Object.keys(rec).sort();
      const syms = Object.getOwnPropertySymbols(rec).filter((s) =>
        Object.prototype.propertyIsEnumerable.call(rec, s),
      );
      if (syms.length !== 0) keys.push(...syms.sort(_compareSymbols));
      // Built with Object.fromEntries, not key-by-key assignment into `{}`:
      // V8 flips an object that grows one property at a time into dictionary
      // mode at ~20 keys, and a canonical record is read (and spread by every
      // produce) for the rest of its life — 6× slower reads, 60–150× slower
      // copies. fromEntries yields a fast-mode object at any width, and it
      // defines `__proto__` as an own data property, which is the record
      // semantics we want.
      const entries: [string | symbol, unknown][] = [];
      for (const k of keys) {
        const v = rec[k];
        if (v === undefined) continue;
        entries.push([k, intern(v)]);
      }
      const internalized = Object.fromEntries(entries);
      return lookupOrStore(internalized, (c) => shallowRefEqual(c, internalized), true) as T;
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
    hashCache.set(obj, h);
    accCache.set(obj, { a: acc, n });
    Object.freeze(obj);
    return pool.register(obj, h);
  }
  const h = deepHash(obj);
  const existing = pool.lookup(h, matches);
  if (existing !== undefined) return existing;
  hashCache.set(obj, h);
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

  const ra = a as Record<string | symbol, unknown>;
  const rb = b as Record<string | symbol, unknown>;
  const keysA = _recordKeys(ra);
  const keysB = _recordKeys(rb);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!childEqual(ra[keysA[i]!], rb[keysA[i]!])) return false;
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
  return hashCache.has(obj);
}

/** @internal The cached accumulator of a canonical plain record/array. */
export function _accOf(obj: object): { a: number; n: number } | undefined {
  return accCache.get(obj);
}

/**
 * @internal Canonicalize plain data whose hash and accumulator were computed
 * incrementally (produce's finalize fast path). The caller guarantees: `obj`
 * is in canonical form (records: sorted keys, no undefined values; children
 * all canonical) and `h`/`acc`/`n` are exactly what `_deepHashWithAcc(obj)`
 * would return.
 */
export function _internPrehashed(obj: object, h: number, acc: number, n: number): object {
  const existing = pool.lookup(h, (c) => shallowRefEqual(c, obj));
  if (existing !== undefined) return existing;
  hashCache.set(obj, h);
  accCache.set(obj, { a: acc, n });
  Object.freeze(obj);
  return pool.register(obj, h);
}
