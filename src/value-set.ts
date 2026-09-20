// ---------------------------------------------------------------------------
// ValueSet — persistent (immutable) set on a hash-consed CHAMP trie
//
// Same architecture as {@link ValueMap} at stride 1 (member-only slots): the
// backing trie is hash-consed, so equal content yields the same root node,
// deep equality is a pointer comparison on roots, updates share all
// untouched structure, and iteration order is content-determined.
// ---------------------------------------------------------------------------

import { equals as equalsSym, hashCode as hashCodeSym, interned as internedSym } from './deep-equal.js';
import { INSPECT, inspectAs, type InspectOptions, type Inspect, findIndexIn, mapIn, filterIn, reduceIn } from './shared.js';
import { intern, internHash } from './intern.js';
import { toDraft, type DraftState } from './draft-core.js';
import { createSetDraft, type SetState } from './draft-set.js';
import {
  createTrieConfig,
  trieGet,
  trieInsert,
  trieRemove,
  trieKeys,
  triePairs,
  trieForEach,
  trieFrom,
  trieUnion,
  trieIntersection,
  trieDifference,
  trieSymmetricDifference,
  trieIsSubset,
  trieIsDisjoint,
  NOT_FOUND,
  type HNode,
} from './hamt.js';

const CFG = createTrieConfig(1);

/**
 * The `ReadonlySet` contract minus the set algebra, whose lib signatures
 * return a native `Set` — ValueSet's return ValueSets. (`forEach` is
 * declared on the class directly: its callback receives the ValueSet.)
 */
type ReadonlySetReads<T> = Pick<
  ReadonlySet<T>,
  'size' | 'has' | 'keys' | 'values' | 'entries' | typeof Symbol.iterator
>;

/**
 * Persistent (immutable) set with structural identity.
 *
 * Elements are **interned on entry**, so two `ValueSet` instances with
 * structurally equal contents are the same object reference — lineage-free,
 * because the backing trie is hash-consed: sets built independently, in
 * different orders, or via add/delete detours converge on one canonical
 * instance, and deep equality is a pointer comparison. Membership probes
 * are canonicalized, so `has`/`delete` accept any structurally equal value.
 *
 * **Iteration order is unspecified but content-determined.** Element order is
 * not part of the value — `{1, 2}` and `{2, 1}` are the *same* canonical
 * instance — so equal sets iterate identically, in an order driven by
 * (per-process, seeded) element hashes. Never attach meaning to it; if order
 * carries meaning, use an `OrderedSet` (or a `ValueList`).
 *
 * The backing trie is a private field — never exposed. The ValueSet has the
 * whole `ReadonlySet` read API and the ES2025 set algebra, with two
 * deliberate differences. The operations take **any iterable of values** —
 * a ValueSet, an array, a native Set — treated as a stream of members
 * interned on entry, with membership decided by this set's equality, never
 * by the argument's `has`. And they return **ValueSets**: canonical values,
 * so `a.union(b) === ValueSet.from([...a, ...b])`. Two ValueSets are merged
 * at node level — hash-consed tries share by pointer wherever they agree —
 * so the cost is proportional to where the operands differ, O(1) for the
 * same set, at worst linear, never a per-member insert. (TypeScript's
 * `ReadonlySet` insists the algebra takes a `ReadonlySetLike` and returns a
 * native `Set`, so the class does not spell `implements ReadonlySet`. It IS
 * set-like — `size`, `has` and `keys` are all the ES2025 protocol asks — so
 * the native methods accept it as their argument: `nativeSet.union(valueSet)`.
 * That is asserted in the tests and not spelled `implements ReadonlySetLike`
 * here: the name would reach the published declarations and make every
 * consumer's `lib` need the ES2025 collection types.)
 * Take a mutable copy with `new Set(valueSet)` when you need one.
 */
export class ValueSet<T> implements ReadonlySetReads<T> {
  readonly #root: HNode;
  readonly #hash: number;

  private constructor(root: HNode) {
    this.#root = root;
    this.#hash = root.h;
    Object.freeze(this);
  }

  /** Cached structural hash — the `[hashCode]` protocol, served from a private field so no own symbol property exists (spread cannot copy the markers). */
  get [hashCodeSym](): number {
    return this.#hash;
  }
  /** The canonical-type marker: every instance is canonical by construction. */
  get [internedSym](): true {
    return true;
  }

  static #for<T>(root: HNode): ValueSet<T> {
    const hit = root.w;
    if (hit !== undefined) return hit as ValueSet<T>;
    const fresh = new ValueSet<unknown>(root);
    root.w = fresh; // the root holds its wrapper: the WeakMap's ephemeron lifetime, without the WeakMap
    return fresh as ValueSet<T>;
  }

  /** Number of elements. */
  get size(): number {
    return this.#root.n;
  }

  /** Whether a structurally equal `value` is present (the probe is canonicalized). */
  has(value: T): boolean {
    value = intern(value);
    return trieGet(CFG, this.#root, internHash(value), value) !== NOT_FOUND;
  }

  /** Iterate the elements (content-determined order — see the class docs). */
  values(): SetIterator<T> {
    return trieKeys(CFG, this.#root) as SetIterator<T>;
  }

  /** Iterate the elements (content-determined order — see the class docs). */
  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  /** Alias of {@link values}, as `ReadonlySet.keys` is. */
  keys(): SetIterator<T> {
    return this.values();
  }

  /** Iterate `[value, value]` pairs, as `ReadonlySet.entries` does. */
  entries(): SetIterator<[T, T]> {
    return triePairs(this.#root) as SetIterator<[T, T]>;
  }

  /** Call `fn` for each element, as `ReadonlySet.forEach` does. */
  forEach(fn: (value: T, value2: T, set: ValueSet<T>) => void, thisArg?: unknown): void {
    trieForEach(CFG, this.#root, (slots, i) => fn.call(thisArg, slots[i] as T, slots[i] as T, this));
  }

  // The functional reads. A callback gets what `forEach` passes: `(value, value, set)`.

  /** The set of `fn`'s results: equal results are one member. */
  map<U>(fn: (value: T, value2: T, set: ValueSet<T>) => U, thisArg?: unknown): ValueSet<U> {
    return ValueSet.from(mapIn(this, this, false, fn as never, thisArg) as U[]);
  }

  /** The members `fn` accepts; `this` when it accepts them all. */
  filter<S extends T>(fn: (value: T, value2: T, set: ValueSet<T>) => value is S, thisArg?: unknown): ValueSet<S>;
  filter(fn: (value: T, value2: T, set: ValueSet<T>) => unknown, thisArg?: unknown): ValueSet<T>;
  filter(fn: (value: T, value2: T, set: ValueSet<T>) => unknown, thisArg?: unknown): ValueSet<T> {
    const kept = filterIn(this, this, false, fn as never, thisArg) as T[];
    return kept.length === this.size ? this : ValueSet.from(kept);
  }

  /** A fold over the members, from `initial`. */
  reduce<U>(fn: (acc: U, value: T, value2: T, set: ValueSet<T>) => U, initial: U): U {
    return reduceIn(this, this, false, 'ValueSet.reduce', [fn, initial]) as U;
  }

  /** Whether `fn` accepts any member. */
  some(fn: (value: T, value2: T, set: ValueSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this, this, false, fn as never, thisArg) !== -1;
  }

  /** Whether `fn` accepts every member. */
  every(fn: (value: T, value2: T, set: ValueSet<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this, this, false, fn as never, thisArg, false) === -1;
  }

  /**
   * What `JSON.stringify` sees: the members, as a fresh plain array. The
   * order is this set's iteration order, which follows the per-process hash
   * seed: the same set stringifies differently in another process, so the
   * string is for reading and logging, never for comparing or keying. Where
   * the order must hold, that is an `OrderedSet` (D46).
   */
  toJSON(): T[] {
    const out: T[] = [];
    trieForEach(CFG, this.#root, (slots, i) => out.push(slots[i] as T));
    return out;
  }

  // -------------------------------------------------------------------------
  // Set algebra — taking any iterable of values, returning ValueSets.
  //
  // The argument is a stream of values: interned on entry, membership decided
  // by THIS set's equality, never by a foreign `has` — so a native Set of raw
  // objects is matched by value like anything else, and the answer does not
  // depend on which operand is larger. The argument becomes a ValueSet (it
  // usually is one) and the two tries merge at node level (hamt.ts): shared
  // subtrees are recognised by pointer and reused, so the cost is
  // proportional to where the operands differ. The result is canonical:
  // `a.union(b) === ValueSet.from([...a, ...b])`.
  // -------------------------------------------------------------------------

  /** `other` as a ValueSet — itself, or the canonical set of its values. */
  static #of<U>(other: Iterable<U>): ValueSet<U> {
    return other instanceof ValueSet ? (other as ValueSet<U>) : ValueSet.from(other);
  }

  /** Members of this set, `other`, or both — a canonical ValueSet. */
  union<U>(other: Iterable<U>): ValueSet<T | U> {
    return ValueSet.#for<T | U>(trieUnion(CFG, this.#root, ValueSet.#of(other).#root));
  }

  /** Members of both this set and `other` — a canonical ValueSet. */
  intersection<U>(other: Iterable<U>): ValueSet<T & U> {
    return ValueSet.#for<T & U>(trieIntersection(CFG, this.#root, ValueSet.#of(other).#root));
  }

  /** Members of this set that are not in `other` — a canonical ValueSet. */
  difference<U>(other: Iterable<U>): ValueSet<T> {
    return ValueSet.#for<T>(trieDifference(CFG, this.#root, ValueSet.#of(other).#root));
  }

  /** Members of exactly one of this set and `other` — a canonical ValueSet. */
  symmetricDifference<U>(other: Iterable<U>): ValueSet<T | U> {
    return ValueSet.#for<T | U>(trieSymmetricDifference(CFG, this.#root, ValueSet.#of(other).#root));
  }

  /** Whether every member of this set is in `other`. */
  isSubsetOf(other: Iterable<unknown>): boolean {
    return trieIsSubset(CFG, this.#root, ValueSet.#of(other).#root);
  }

  /** Whether this set contains every member of `other`. */
  isSupersetOf(other: Iterable<unknown>): boolean {
    return trieIsSubset(CFG, ValueSet.#of(other).#root, this.#root);
  }

  /** Whether this set shares no member with `other`. */
  isDisjointFrom(other: Iterable<unknown>): boolean {
    return trieIsDisjoint(CFG, this.#root, ValueSet.#of(other).#root);
  }

  /** What `console.log` shows (Node's `util.inspect`): `ValueSet(n)` and the contents, where private state would print as `ValueSet {}`. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectAs('ValueSet', this.size, () => new Set(this), depth, options, inspect);
  }
  /** `[object ValueSet]`, and the name a minifier cannot take. */
  get [Symbol.toStringTag](): string {
    return 'ValueSet';
  }

  [equalsSym](other: unknown): boolean {
    // Hash consing makes deep equality a pointer comparison on roots. `#root in`
    // and not `instanceof`: an object that merely inherits the prototype has no
    // root to compare, and a predicate answers false, it does not throw.
    return typeof other === 'object' && other !== null && #root in other && (other as ValueSet<T>).#root === this.#root;
  }

  /** The `produce` draft protocol: a {@link DraftSet} over this set. */
  [toDraft](parent?: DraftState): SetState<T> {
    return createSetDraft(this, parent, ValueSet.empty);
  }

  /** Add `value` (interned on entry). Returns `this` if a structural equal is present. */
  add(value: T): ValueSet<T> {
    value = intern(value);
    const r = trieInsert(CFG, this.#root, 0, internHash(value), [value]);
    if (r === null) return this;
    return ValueSet.#for<T>(r.node);
  }

  /** Remove a structurally equal `value`. Returns `this` if not present. */
  delete(value: T): ValueSet<T> {
    value = intern(value);
    const r = trieRemove(CFG, this.#root, 0, internHash(value), value);
    if (r === null) return this;
    return ValueSet.#for<T>(r.node as HNode);
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /** Canonical empty set. */
  static empty<T>(): ValueSet<T> {
    return ValueSet.#for<T>(CFG.empty);
  }

  /**
   * The canonical set of `values` (interned on entry), as `ValueList.of` and
   * `OrderedSet.of`: the members are the arguments, so `of([1, 2])` has one
   * member, an array. Equal values are one member. For an iterable, `from`.
   */
  static of<T>(...values: T[]): ValueSet<T> {
    return ValueSet.from(values);
  }

  /**
   * Canonical ValueSet from an iterable of values (interned on entry). Built
   * in one bottom-up pass — every trie node consed once — not by n adds.
   */
  static from<T>(values: Iterable<T>): ValueSet<T> {
    const members: unknown[] = [];
    for (const raw of values) members.push(intern(raw));
    return ValueSet.#for<T>(trieFrom(CFG, members, null));
  }
}
