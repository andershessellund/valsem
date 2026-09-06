// ---------------------------------------------------------------------------
// deepHash — polymorphic structural hash
//
// Companion to deepEqual: deepEqual(a, b) === true → deepHash(a) === deepHash(b)
//
// Dispatch order (mirrors deepEqual):
//   1. Primitives → direct hash
//   2. Array → recursive ordered hash
//   3. a[hashCode]?.() → class-defined hash
//   4. hashCodeMethods.get(a.constructor) → registry (registered types)
//   5. Plain object → structural order-independent hash
//   6. Class without handler → throw
// ---------------------------------------------------------------------------

import { hashCode, _recordKeys } from './deep-equal.js';
import { _hashCodeMethods, _mutableBuiltinReason } from './deep-equal.js';
import { hashString, hashNumber } from './hasher.js';
import { _depthError, _maxDepth } from './limits.js';

/**
 * @internal The one hash cache: canonical object → its precomputed hash (the
 * interner fills it, so internalized children hash in O(1)), and unique
 * symbol → the identity hash assigned on first sight. Lives here rather than
 * in the interner because the hasher is the lower layer and needs it for
 * symbols even when nothing is ever interned. deepEqual reads the same map
 * as its canonicality probe.
 */
export const _hashCache = new WeakMap<WeakKey, number | CanonicalMeta>();

/**
 * @internal What a canonical object carries: its hash, and for plain
 * records/arrays the raw accumulator and defined-entry count (`n` is -1 for
 * pooled value types), so produce's finalize can hash a successor
 * incrementally. The object is the WeakMap key and the meta never refers
 * back to it: a WeakMap value that points at its own key is an ephemeron
 * chain V8's marker has to resolve iteratively, measured at ~2× on the
 * GC-bound produce arenas (BENCHMARKS.md). Storing the meta ON the value as
 * a hidden property was measured too — 5% cheaper admission — and rejected
 * for what it makes observable.
 */
export interface CanonicalMeta {
  readonly h: number;
  readonly a: number;
  readonly n: number;
}

/** @internal The meta of a canonical object, or undefined for anything else. */
export function _metaOf(obj: object): CanonicalMeta | undefined {
  const m = _hashCache.get(obj);
  return typeof m === 'object' ? m : undefined;
}

/** @internal Record `obj` as canonical with hash `h` (and accumulator `a`/`n`; `n` -1 when not plain data). */
export function _setMeta(obj: object, h: number, a: number, n: number): void {
  _hashCache.set(obj, { h, a, n });
}

// Type tags — mixed into hash to distinguish types with similar content
const TAG_NULL = 0x4e4c;
const TAG_UNDEFINED = 0x5544;
const TAG_TRUE = 0x5445;
const TAG_FALSE = 0x4653;
const TAG_NUMBER = 0x4e4d;
const TAG_STRING = 0x5354;
const TAG_BIGINT = 0x4249;
const TAG_ARRAY = 0x4152;
const TAG_OBJECT = 0x4f42;
const TAG_SYMBOL = 0x5359;
const TAG_UNIQUE_SYMBOL = 0x5553;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ordered hash combine (position-dependent). Based on boost::hash_combine. */
function mix(seed: number, hash: number): number {
  return (seed ^ (hash + 0x9e3779b9 + (seed << 6) + (seed >>> 2))) >>> 0;
}

/**
 * Scramble a hash value for use in unordered accumulation.
 * Ensures similar-but-different entries don't cancel out under addition.
 */
function scramble(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Accumulator forms — the incremental-hashing contract
//
// Records and arrays hash through an ACCUMULATOR that is a sum (mod 2³²) of
// independent per-entry terms, so a canonical base's cached accumulator can
// be delta-updated in O(changes) by produce's finalize:
//
//   record: acc = Σ entryTerm(key, valueHash)          (commutative)
//   array:  acc = Σ elementTerm(i, elementHash)        (positional, P odd)
//
// and the final hash folds in the count/length. These helpers are the single
// source of truth for both the from-scratch and the incremental paths.
// ---------------------------------------------------------------------------

const P = 0x9e3779b1 | 0; // odd (golden-ratio derived) — positional multiplier

/** @internal P^n mod 2³² via square-and-multiply. */
export function _powP(n: number): number {
  let result = 1;
  let base = P;
  let e = n >>> 0;
  while (e > 0) {
    if (e & 1) result = Math.imul(result, base);
    base = Math.imul(base, base);
    e >>>= 1;
  }
  return result | 0;
}

// ---------------------------------------------------------------------------
// Symbols
//
// A registered symbol (`Symbol.for(name)`) IS its name — one per name in the
// whole process, so the name's hash is its hash, stable across installs and
// realms. A unique symbol (`Symbol(desc)`, and the well-known ones) is an
// identity with no content: it gets a per-symbol hash on first sight, kept
// in the shared hash cache (unique symbols are valid weak keys since ES2023;
// registered ones are not, which is exactly why they take the other branch).
// The counter is mixed through the seeded hasher like every other leaf.
// ---------------------------------------------------------------------------

let uniqueSymbolCount = 0;

/** @internal The hash of a symbol value or key. */
export function _symbolHash(s: symbol): number {
  const key = Symbol.keyFor(s);
  if (key !== undefined) return mix(TAG_SYMBOL, hashString(key));
  let h = _hashCache.get(s) as number | undefined;
  if (h === undefined) {
    h = mix(TAG_UNIQUE_SYMBOL, hashNumber(++uniqueSymbolCount));
    _hashCache.set(s, h);
  }
  return h;
}

/** @internal One record entry's accumulator term. */
export function _entryTerm(key: string | symbol, valueHash: number): number {
  return scramble(mix(typeof key === 'string' ? hashString(key) : _symbolHash(key), valueHash));
}

/** @internal One array element's accumulator term. */
export function _elementTerm(index: number, elementHash: number): number {
  return Math.imul(elementHash, _powP(index));
}

/** @internal Fold a record accumulator into the final hash. */
export function _recordHashOf(keyCount: number, acc: number): number {
  return mix(mix(TAG_OBJECT, keyCount), acc >>> 0);
}

/** @internal Fold an array accumulator into the final hash. */
export function _arrayHashOf(length: number, acc: number): number {
  return mix(mix(TAG_ARRAY, length), acc >>> 0);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Names of the Temporal types that `valsem/temporal` registers. */
const TEMPORAL_KINDS = new Set([
  'PlainDate', 'PlainDateTime', 'PlainTime', 'PlainYearMonth',
  'PlainMonthDay', 'Instant', 'ZonedDateTime', 'Duration',
]);

/**
 * Build the error for a value with no way to hash it. Mutable built-ins and
 * Temporal values get pointed hints, because reaching this through `decode`
 * (which interns by default) is the most likely way to hit it.
 */
function unhashableMessage(obj: object): string {
  const ctor = obj.constructor as Function | undefined;
  const name = ctor?.name ?? 'unknown';

  const reason = _mutableBuiltinReason(ctor);
  if (reason !== undefined) {
    return `deepHash: ${name} is not supported — valsem gives value semantics to ` +
      `immutable values only, and ${reason}.`;
  }

  const T = (globalThis as { Temporal?: Record<string, unknown> }).Temporal;
  if (T !== undefined && TEMPORAL_KINDS.has(name) && T[name] === ctor) {
    return `deepHash: Temporal.${name} has no registered hash handler. ` +
      `Add Temporal support with a side-effect import: import 'valsem/temporal';`;
  }

  return `deepHash: class instance '${name}' has no [hashCode] or registered hash handler`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deep structural hash with polymorphic dispatch.
 *
 * Companion to {@link deepEqual}: if `deepEqual(a, b)` is `true`, then
 * `deepHash(a) === deepHash(b)` is guaranteed. The reverse is not
 * guaranteed (hash collisions are possible).
 *
 * Handles: primitives (including `NaN`, `+0`/`-0`, `bigint`), plain objects
 * (key-order-independent), arrays, and any class implementing `[hashCode]` or
 * registered via `deepEqual.register()`.
 *
 * Symbols are values: a registered symbol hashes by its name, a unique one
 * by an identity assigned on first sight. Symbol-keyed record entries count
 * like string-keyed ones.
 *
 * Throws for functions and class instances without a hash handler —
 * including the mutable built-ins `Date`, `RegExp`, `Map`, `Set`, and the
 * TypedArrays, which valsem does not treat as values. Those errors name the
 * immutable replacement.
 *
 * @example
 * ```ts
 * deepHash({ a: 1, b: 2 }) === deepHash({ b: 2, a: 1 }); // true
 * deepHash([1, 2]) !== deepHash([2, 1]);                   // true — order matters
 * deepHash(new Set([1, 2, 3]));                            // throws — use ValueSet
 * ```
 */
export function deepHash(value: unknown): number {
  if (value === null) return TAG_NULL;
  if (value === undefined) return TAG_UNDEFINED;

  switch (typeof value) {
    case 'boolean':
      return value ? TAG_TRUE : TAG_FALSE;
    case 'number':
      return mix(TAG_NUMBER, hashNumber(value === 0 ? 0 : value)); // normalize -0 → +0
    case 'string':
      return mix(TAG_STRING, hashString(value));
    case 'bigint':
      return mix(TAG_BIGINT, hashString(String(value)));
    case 'symbol':
      return _symbolHash(value);
    case 'function':
      throw new TypeError(`deepHash: function is not supported`);
  }

  const obj = value as object;

  // Canonical objects carry their hash (the interner fills the meta store).
  const meta = _metaOf(obj);
  if (meta !== undefined) return meta.h;

  // Decode-boundary depth cap: the recursive walk below is where hostile
  // (or cyclic) input would otherwise exhaust the stack. Cached canonical
  // material never reaches this counter. The increment sits INSIDE the
  // protected region so the cap check's own throw unwinds it too — an
  // increment before the `try` leaks +1 per rejection, and after enough
  // rejections every call is over the cap.
  depth++;
  try {
    if (depth > _maxDepth()) throw _depthError('deepHash');
    return hashObjectValue(obj);
  } finally {
    depth--;
  }
}

let depth = 0;

function hashObjectValue(obj: object): number {
  // Array — order-dependent positional accumulator (see the accumulator
  // contract above: this form is what makes array hashes delta-updatable).
  if (Array.isArray(obj)) {
    let acc = 0;
    let pPow = 1;
    for (let i = 0; i < obj.length; i++) {
      acc = (acc + Math.imul(deepHash(obj[i]), pPow)) | 0;
      pPow = Math.imul(pPow, P);
    }
    return _arrayHashOf(obj.length, acc);
  }

  // [hashCode] symbol — class-defined hash (takes priority over registry).
  // Accepts either a property (number) or a legacy method form.
  if (hashCode in (obj as any)) {
    const hc = (obj as any)[hashCode];
    if (typeof hc === 'number') return hc >>> 0;
    if (typeof hc === 'function') return hc.call(obj) >>> 0;
  }

  // Registry lookup by constructor
  const handler = _hashCodeMethods.get(obj.constructor as Function);
  if (handler) return handler(obj);

  // Plain object — key-order-independent
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(unhashableMessage(obj));
  }

  // Own enumerable keys only — the same key set deepEqual and intern see. A
  // `for...in` here would also walk inherited enumerable keys, and under
  // prototype pollution the hash of an Object.prototype record would then
  // diverge from an equal null-prototype record's, breaking the invariant.
  const rec = obj as Record<string | symbol, unknown>;
  const keys = _recordKeys(rec);
  let acc = 0;
  let keyCount = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = rec[k];
    if (v === undefined) continue; // undefined-valued key ≡ absent (matches deepEqual)
    acc = (acc + _entryTerm(k, deepHash(v))) >>> 0;
    keyCount++;
  }
  return _recordHashOf(keyCount, acc);
}

/**
 * @internal deepHash for a plain record or array, also returning the raw
 * accumulator (and defined-key count for records) so canonicalization can
 * cache them for incremental finalize hashing.
 */
export function _deepHashWithAcc(obj: object): { h: number; acc: number; n: number } {
  if (Array.isArray(obj)) {
    let acc = 0;
    let pPow = 1;
    for (let i = 0; i < obj.length; i++) {
      acc = (acc + Math.imul(deepHash(obj[i]), pPow)) | 0;
      pPow = Math.imul(pPow, P);
    }
    return { h: _arrayHashOf(obj.length, acc), acc: acc >>> 0, n: obj.length };
  }
  const rec = obj as Record<string | symbol, unknown>;
  const keys = _recordKeys(rec); // own keys only — see hashObjectValue
  let acc = 0;
  let n = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = rec[k];
    if (v === undefined) continue;
    acc = (acc + _entryTerm(k, deepHash(v))) >>> 0;
    n++;
  }
  return { h: _recordHashOf(n, acc), acc, n };
}
