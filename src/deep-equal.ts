// ---------------------------------------------------------------------------
// deepEqual — polymorphic structural equality
//
// Dispatch order:
//   1. a === b → true (NaN handled at tail)
//   2. Primitives / null → false (or NaN === NaN)
//   3. Array (Array.isArray — cross-realm safe)
//   4. a[equals]?(b) — class-defined value semantics
//   5. equalsMethods.get(a.constructor) — registry (registered types)
//   6. Plain object (prototype === Object.prototype or null) → structural
//   7. Otherwise → false (class instance = reference semantics)
//
// Mutable built-ins are deliberately absent. `Date`, `RegExp`, `Map`, `Set`,
// and the TypedArray family all carry state that can change after construction,
// which makes them unusable as values: a canonical instance is shared by every
// holder, so one mutation corrupts all of them and invalidates the hash cached
// against it. They fall through to reference semantics here, and `deepHash`
// rejects them outright with a message naming the immutable replacement.
//
// No circular reference handling — state values should be plain data.
// ---------------------------------------------------------------------------

/**
 * Symbol for opt-in value semantics on class instances.
 *
 * Implement this on a class to enable deep structural equality:
 *
 * ```ts
 * class Money {
 *   constructor(readonly amount: number, readonly currency: string) {}
 *   [equals](other: unknown): boolean {
 *     return other instanceof Money
 *       && this.amount === other.amount
 *       && this.currency === other.currency;
 *   }
 * }
 * ```
 */
export const equals: unique symbol = Symbol.for('valsem.equals') as any;

/**
 * Symbol for companion hash code on class instances.
 *
 * May be either a **property** (precomputed `number`, preferred — O(1)
 * read) or a **method** returning `number` (legacy form).
 *
 * Must be implemented alongside {@link equals} to maintain the invariant:
 * `a[equals](b) === true → readHash(a) === readHash(b)`.
 */
export const hashCode: unique symbol = Symbol.for('valsem.hashCode') as any;

/**
 * Symbol marking an object as already canonicalized by the interner.
 *
 * When an object exposes `[interned] === true`, {@link intern} returns it
 * immediately without pool lookup. Persistent collections
 * ({@link InternArray}, {@link InternMap}, {@link InternSet},
 * {@link InternString}) set this flag on their prototype so every
 * instance is recognised as canonical for free.
 */
export const interned: unique symbol = Symbol.for('valsem.interned') as any;

// ---------------------------------------------------------------------------
// Type-handler registry
// ---------------------------------------------------------------------------

const equalsMethods = new Map<Function, (a: any, b: any) => boolean>();
const hashCodeMethods = new Map<Function, (a: any) => number>();

/**
 * Types whose instances are declared deeply immutable, and may therefore be
 * pooled by {@link intern} (canonical `===` instances) instead of passing
 * through untouched.
 *
 * This is deliberately NOT implied by having handlers registered: a registered
 * type is comparable and hashable, which says nothing about whether it can
 * change afterwards. Only a type that cannot be mutated after construction
 * (Temporal, and consumer types that opt in) is safe to canonicalize, because a
 * canonical instance is shared by every holder — one mutation corrupts all of
 * them and invalidates the hash cached against it.
 */
const immutableTypes = new Set<Function>();

// ---------------------------------------------------------------------------
// Mutable built-ins valsem refuses to treat as values
// ---------------------------------------------------------------------------

/**
 * The mutable built-ins valsem deliberately does not give value semantics,
 * each with the reason and its immutable replacement.
 *
 * `deepEqual` cannot report these — it is a total function and answers `false`
 * — so the whole diagnostic budget is spent in `deepHash` and `intern` — and
 * in any serialization binding's encode, via `valsem/binding` — which all
 * throw and all share these strings.
 */
const MUTABLE_BUILTINS = new Map<Function, string>([
  [Date, 'a Date can be re-timed with setTime(). Use Temporal.Instant instead: ' +
    "Temporal.Instant.fromEpochMilliseconds(date.getTime()), with import 'valsem/temporal'"],
  [RegExp, 'a RegExp carries a mutable lastIndex cursor, and is behavior rather than ' +
    'data. Carry { source, flags } as a plain record instead'],
  [Map, 'a Map can be written to after construction. Use InternMap.from(...), which ' +
    'has value semantics and canonical instances'],
  [Set, 'a Set can be written to after construction. Use InternSet.from(...), which ' +
    'has value semantics and canonical instances'],
]);

// TypedArrays, DataView, and ArrayBuffer share one story: the bytes are
// rewritable through ANY view over the same buffer, so no instance can ever be
// immutable — Object.freeze throws on a non-empty view, and would not protect
// the buffer even if it succeeded. (TC39's immutable-ArrayBuffer proposal
// changes this; support can return gated on `buffer.immutable` once it ships.)
const BYTES_REASON =
  'its bytes can be rewritten through any view over the same buffer, so no ' +
  'instance can be immutable (Object.freeze throws on a non-empty TypedArray). ' +
  'For binary data as a value, use a hex or base64 string';
for (const T of [
  Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array,
  Int32Array, Uint32Array,
  Float32Array, Float64Array,
  BigInt64Array, BigUint64Array,
  DataView, ArrayBuffer,
  // Not in every runtime (or TS lib) yet — picked up when present.
  ...[(globalThis as { Float16Array?: Function }).Float16Array ?? []].flat(),
  ...[(globalThis as { SharedArrayBuffer?: Function }).SharedArrayBuffer ?? []].flat(),
]) {
  MUTABLE_BUILTINS.set(T as Function, BYTES_REASON);
}

/**
 * Why valsem refuses `ctor` as a value, or `undefined` if it does not.
 *
 * @internal — shared by deepHash, intern, and the codec so one type gives one
 * explanation wherever a user meets it.
 */
export function _mutableBuiltinReason(ctor: Function | undefined): string | undefined {
  return ctor === undefined ? undefined : MUTABLE_BUILTINS.get(ctor);
}

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------

/**
 * Deep structural equality with polymorphic dispatch.
 *
 * Supports primitives, plain objects, arrays, and any class implementing
 * `[equals]` or registered via `deepEqual.register()`.
 *
 * Class instances without `[equals]` or a registered handler use
 * reference semantics (only equal if `Object.is` returns `true`). That includes
 * the mutable built-ins `Date`, `RegExp`, `Map`, `Set`, and the TypedArrays,
 * which valsem does not treat as values — use `Temporal`, a `{ source, flags }`
 * record, `InternMap`, `InternSet`, or a hex/base64 string instead. `deepHash`
 * rejects them with a message naming the replacement; `deepEqual` cannot throw,
 * so it reports `false`.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object')
    return a !== a && b !== b; // NaN === NaN

  // Array — cross-realm safe via Array.isArray
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // [equals] symbol — class-defined value semantics (takes priority over registry).
  // The [equals] reference is also the kind discriminator: two objects with
  // mismatched [equals] references are never considered equal.
  if (equals in (a as any)) {
    const eq = (a as any)[equals];
    if (typeof eq !== 'function') return false;
    if ((b as any)[equals] !== eq) return false;
    return eq.call(a, b);
  }

  // Registry lookup by constructor
  if (a.constructor === b.constructor) {
    const handler = equalsMethods.get(a.constructor as Function);
    if (handler) return handler(a, b);
  }

  // Plain object — structural recursive.
  //
  // A record is a partial function from string keys to values, and `undefined`
  // is NOT a value: a key mapped to `undefined` is the same as an absent key
  // (`{ a: undefined }` equals `{}`). The distinction is almost always an
  // accident of construction — `{ ...base, x: opts.x }`, optional arguments —
  // and `intern` erases it from the canonical form, so equality must not see
  // it either. Model "present but empty" with `null`. (`InternMap` is the
  // opposite by design: storing `undefined` there is intentional, and IS
  // distinct from absence.)
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.prototype && protoA !== null) return false;
  const protoB = Object.getPrototypeOf(b);
  if (protoB !== Object.prototype && protoB !== null) return false;

  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let count = 0;
  for (const k in ra) {
    if (!Object.prototype.hasOwnProperty.call(ra, k)) continue;
    const va = ra[k];
    if (va === undefined) continue; // undefined-valued key ≡ absent
    const vb = Object.prototype.hasOwnProperty.call(rb, k) ? rb[k] : undefined;
    if (!deepEqual(va, vb)) return false; // vb === undefined fails here, as it must
    count++;
  }
  // b must have no extra populated keys (undefined-valued ones don't count).
  let bCount = 0;
  for (const k in rb) {
    if (Object.prototype.hasOwnProperty.call(rb, k) && rb[k] !== undefined) bCount++;
  }
  return count === bCount;
}

/** Options for {@link deepEqual.register}. */
export interface RegisterOptions {
  /**
   * Declare that instances of this type are **deeply immutable** after
   * construction, allowing {@link intern} to pool them as canonical `===`
   * instances rather than passing them through untouched.
   *
   * Default `false`. Only set this when the type genuinely cannot be mutated —
   * a pooled instance is shared by every holder, so a single mutation corrupts
   * all of them and invalidates the pooled hash.
   *
   * "Immutable" means no reachable mutation, not merely no obvious setter.
   * `Object.freeze` is not a proof: it does not reach the internal slots of a
   * `Date` or a `Map`, it makes a `RegExp`'s `lastIndex` read-only (breaking
   * `.exec()`), and it throws outright on a non-empty TypedArray — whose bytes
   * are rewritable through any other view over the same buffer anyway.
   */
  readonly immutable?: boolean;
}

/**
 * Register equality and hash handlers for a type.
 *
 * Both `equalsFn` and `hashFn` are required to enforce the invariant:
 * `equalsFn(a, b) === true → hashFn(a) === hashFn(b)`.
 *
 * Pass `{ immutable: true }` for types that cannot be mutated after
 * construction; those become internable (canonical `===` instances) instead of
 * passing through {@link intern} untouched.
 *
 * @example
 * ```ts
 * deepEqual.register(
 *   Money,
 *   (a, b) => a.amount === b.amount && a.currency === b.currency,
 *   (m) => deepHash(`${m.amount}|${m.currency}`),
 *   { immutable: true },
 * );
 * ```
 */
deepEqual.register = function register<T>(
  type: new (...args: any[]) => T,
  equalsFn: (a: T, b: T) => boolean,
  hashFn: (a: T) => number,
  opts?: RegisterOptions,
): void {
  equalsMethods.set(type, equalsFn);
  hashCodeMethods.set(type, hashFn);
  if (opts?.immutable) immutableTypes.add(type);
  else immutableTypes.delete(type);
};

/**
 * Whether `type` has both an equality and a hash handler — either registered
 * via {@link deepEqual.register}, or declared on its prototype via the
 * {@link equals} symbol.
 *
 * The symbol form only requires `[equals]` on the prototype: `[hashCode]` is
 * conventionally an instance field assigned during construction (as the
 * `Intern*` collections and the `createInternPool` pattern both do), so it is
 * not observable from the constructor alone.
 *
 * @internal — exposed through `valsem/binding` for registration guards that
 * must reject types that would crash an interning pass (e.g. a wire decoder's).
 */
export function _hasValueSemantics(type: Function): boolean {
  if (equalsMethods.has(type) && hashCodeMethods.has(type)) return true;
  const proto = (type as { prototype?: unknown }).prototype;
  return typeof proto === 'object' && proto !== null && equals in (proto as object);
}

/**
 * Assign `out[key] = value` with **define** semantics, so a key named
 * `__proto__` becomes an ordinary own data property instead of triggering the
 * `Object.prototype.__proto__` setter — which would silently swap the object's
 * prototype for an attacker-controlled one and drop the key. Wire data and
 * `JSON.parse` output can legitimately carry such a key, so every record the
 * package builds from external keys goes through this.
 *
 * @internal — shared by intern and the codec layer.
 */
export function _defineRecordField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    out[key] = value;
  }
}

/** @internal — exposed for deepHash to read the shared registry. */
export { equalsMethods as _equalsMethods, hashCodeMethods as _hashCodeMethods };

/** @internal — exposed for intern to know which rich types are poolable. */
export { immutableTypes as _immutableTypes };
