// ---------------------------------------------------------------------------
// FastMap and FastSet — native Map and Set for canonical keys.
//
// Once keys are canonical, `===` IS value equality, so a native Map keyed by
// reference is already a map keyed by value — at native speed, with nothing
// valsem could add. What it can add is the check: a raw key in such a map
// silently misses, so while checks are on every key is verified canonical
// (a primitive, or something that came out of intern/produce/a collection)
// and a raw one throws at the call site. `skipChecks()` removes even that:
// `new FastMap()` then returns a plain native Map — the constructor hands
// back `new Map()` itself — so the cost is exactly the native cost.
//
// The name lines up with `fastEquals`: "fast" means canonical in, checked.
// For keys that are fresh values every call, `HashMap`/`HashSet` match by
// content instead.
// ---------------------------------------------------------------------------

import { isCanonical } from './intern.js';
import { _checking } from './checks.js';

function assertCanonicalKey(kind: string, what: string, value: unknown): void {
  if (_checking() && !isCanonical(value)) {
    throw new TypeError(
      `valsem: ${kind} takes canonical ${what}s only — a raw one would silently miss. ` +
        `Intern it first (intern(), produce(), or a collection), or use Hash${kind.slice(4)} to match by content. ` +
        'skipChecks() disables this check.',
    );
  }
}

/**
 * A native `Map` whose keys must be canonical — so reference equality is
 * value equality and lookups run at native speed. While checks are on, a
 * raw key throws instead of silently missing; after `skipChecks()` the
 * constructor returns a plain `Map`.
 */
export class FastMap<K, V> extends Map<K, V> {
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    if (!_checking()) return new Map<K, V>(entries) as FastMap<K, V>;
    super();
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }
  override get(key: K): V | undefined {
    assertCanonicalKey('FastMap', 'key', key);
    return super.get(key);
  }
  override has(key: K): boolean {
    assertCanonicalKey('FastMap', 'key', key);
    return super.has(key);
  }
  override set(key: K, value: V): this {
    assertCanonicalKey('FastMap', 'key', key);
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    assertCanonicalKey('FastMap', 'key', key);
    return super.delete(key);
  }
}

/**
 * A native `Set` whose members must be canonical — see {@link FastMap}.
 */
export class FastSet<T> extends Set<T> {
  constructor(values?: Iterable<T> | null) {
    if (!_checking()) return new Set<T>(values) as FastSet<T>;
    super();
    if (values) for (const v of values) this.add(v);
  }
  override has(value: T): boolean {
    assertCanonicalKey('FastSet', 'element', value);
    return super.has(value);
  }
  override add(value: T): this {
    assertCanonicalKey('FastSet', 'element', value);
    return super.add(value);
  }
  override delete(value: T): boolean {
    assertCanonicalKey('FastSet', 'element', value);
    return super.delete(value);
  }
}
