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
//   7. Class without handler → throw
// ---------------------------------------------------------------------------

import { hashCode } from './deep-equal.js';
import { _hashCodeMethods, _mutableBuiltinReason } from './deep-equal.js';
import { hashString, hashNumber } from './hasher.js';

// Hook for interner: when set, deepHash checks this WeakMap before recursing.
// This is set by the intern module to enable O(1) hash for internalized objects.
export let _precomputedHashes: WeakMap<object, number> | null = null;

/** @internal Set the precomputed hash cache used by deepHash. */
export function _setPrecomputedHashes(map: WeakMap<object, number> | null): void {
  _precomputedHashes = map;
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
 * Throws for symbols, functions, and class instances without a hash handler —
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
    case 'function':
      throw new TypeError(`deepHash: ${typeof value} is not supported`);
  }

  const obj = value as object;

  // Check precomputed hash cache (set by interner)
  if (_precomputedHashes !== null) {
    const cached = _precomputedHashes.get(obj);
    if (cached !== undefined) return cached;
  }

  // Array — order-dependent
  if (Array.isArray(obj)) {
    let h = mix(TAG_ARRAY, obj.length);
    for (let i = 0; i < obj.length; i++) {
      h = mix(h, deepHash(obj[i]));
    }
    return h;
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

  const rec = obj as Record<string, unknown>;
  let acc = 0;
  let keyCount = 0;
  for (const k in rec) {
    const v = rec[k];
    if (v === undefined) continue; // undefined-valued key ≡ absent (matches deepEqual)
    acc = (acc + scramble(mix(hashString(k), deepHash(v)))) >>> 0;
    keyCount++;
  }
  return mix(mix(TAG_OBJECT, keyCount), acc);
}
