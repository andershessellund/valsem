// ---------------------------------------------------------------------------
// DraftList — the mutable twin of ValueList inside produce().
//
// Never materialises. The state keeps a persistent working list (`work`)
// that tracks POSITIONS — every structural op is applied to it at O(log n)
// as it happens, with `undefined` placeholders where new elements went —
// and an overlay from current index to what the recipe actually sees
// there: a child draft (drafted on read), or the caller's own raw
// assignment (which stays raw until finalize, the immer rule). A splice
// re-indexes the overlay, O(edits). Finalize resolves the overlay onto
// `work` — O(k log n) for k touched positions — and the recorded ops become
// `list.set`/`list.splice` patches exactly as for DraftList.
// ---------------------------------------------------------------------------

import {
  DRAFT_STATE,
  createDraftState,
  stateOf,
  isDraftable,
  same,
  markChanged,
  assertUnrevoked,
  assertAssignable,
  createChildDraft,
  resolve,
  snapshotOf,
  isImmutable,
  emitSeqOps,
  type DraftState,
  type Patch,
  type PatchPath,
  type PatchRecorder,
  type SeqOp,
  inspectDraft,
} from './draft-core.js';
import { intern } from './intern.js';
import type { ValueList } from './value-list.js';
import type { Draft } from './produce.js';
import { atIndex, spliceArgs, elementIndex, insertionIndex, findIndexIn, reduceIn, INSPECT, type Inspect, type InspectOptions } from './shared.js';

const INTERNAL = Symbol('valsem.draft-list');

interface Entry {
  v: unknown;
  /** true = assigned by the recipe (its own material); false = child-drafted on read. */
  assigned: boolean;
}

/**
 * The state behind a {@link DraftList}. Its bookkeeping is not API: the
 * fields below the two the protocol needs (`kind`, `draft`) are tagged
 * internal, out of the published declarations, free to change in any release.
 */
export interface ListState<T = unknown> extends DraftState<ValueList<T>> {
  kind: 'list';
  /** @internal Positions and canonical placeholders for everything but the tail. */
  work: ValueList<unknown>;
  /** @internal Current index (below `work.length`) → what the recipe sees there. */
  overlay: Map<number, Entry>;
  /** @internal The highest index the overlay has held: an upper bound, so a splice past it has nothing to re-index. */
  overlayHi: number;
  /** @internal Pushed values not yet in `work` — flushed as one splice by a structural op, or at finalize. */
  tail: Entry[];
  /** @internal */
  ops: SeqOp[];
  draft: DraftList<T>;
}

/** What the recipe sees at `index`, if it is overlaid or in the tail, else undefined (the value is then `work`'s). */
function entryAt(s: ListState, index: number): Entry | undefined {
  const wl = s.work.length;
  return index < wl ? s.overlay.get(index) : s.tail[index - wl];
}

function readAt(s: ListState, index: number): unknown {
  const e = entryAt(s, index);
  return e !== undefined ? e.v : s.work.get(index);
}

function overlaySet(s: ListState, index: number, entry: Entry): void {
  s.overlay.set(index, entry);
  if (index > s.overlayHi) s.overlayHi = index;
}

/** Move the tail into `work` (as placeholders) and the overlay — before a splice needs exact positions. */
function flushTail(s: ListState): void {
  if (s.tail.length === 0) return;
  const len = s.work.length;
  s.work = s.work._spliceItems(len, 0, new Array<unknown>(s.tail.length).fill(undefined));
  for (let j = 0; j < s.tail.length; j++) overlaySet(s, len + j, s.tail[j]!);
  s.tail = [];
}

/**
 * What a removal verb hands back: the removed element as `get` would have
 * handed it out — its child draft if it has one; drafted if it is a value
 * (an element of the list, canonical by construction, or a frozen value the
 * recipe assigned); the recipe's own raw material raw — so `const t =
 * d.todos.shift(); t.done = true; d.done.push(t)` edits, as on a plain array.
 */
function handOut(s: ListState, value: unknown): unknown {
  if (s.finalized || !isDraftable(value) || stateOf(value) !== undefined) return value;
  return isImmutable(value) ? createChildDraft(value, s) : value;
}

/**
 * `removed`, each element handed out as {@link handOut} would — on first
 * read, through a Proxy, so `const [t] = d.todos.splice(i, 1)` edits and
 * `d.l.splice(0, 50_000)` drafts nothing. A draft made replaces the raw
 * slot; the op log keeps its own copy of the raw elements.
 */
function lazyHandOut(s: ListState, removed: unknown[]): unknown[] {
  if (removed.length === 0) return removed;
  return new Proxy(removed, {
    get(target, prop, receiver) {
      const i = typeof prop === 'string' && /^(?:0|[1-9]\d*)$/.test(prop) ? Number(prop) : -1;
      if (i !== -1 && i < target.length) {
        const v = target[i];
        const h = handOut(s, v);
        if (h !== v) target[i] = h;
        return h;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The splice every path shares — the verbs and a `list.splice` patch — with
 * the arguments checked already: `at` in `[0, length]`, `rc` clamped to what
 * is there, the values as an array (a patch may insert 150,000 of them: no
 * spread). Returns the removed elements, raw.
 */
function spliceList(s: ListState, at: number, rc: number, values: readonly unknown[]): unknown[] {
  for (const v of values) assertAssignable(v, s);
  flushTail(s);
  markChanged(s);
  const removed: unknown[] = [];
  for (let i = at; i < at + rc; i++) {
    const e = s.overlay.get(i);
    removed.push(e !== undefined ? e.v : s.work.get(i));
  }
  s.ops.push({ t: 'splice', i: at, rc, inserted: values.slice(), removed: removed.slice() });
  s.work = s.work._spliceItems(at, rc, new Array<unknown>(values.length).fill(undefined));
  // Re-index the overlay around the edit — only the entries at or past `at`
  // move or go, so an edit past every overlaid index (a push replayed as a
  // tail splice, 5,000 times) touches none of them.
  const delta = values.length - rc;
  if (s.overlay.size !== 0 && at <= s.overlayHi && (delta !== 0 || rc !== 0)) {
    const next = new Map<number, Entry>();
    let hi = -1;
    for (const [i, e] of s.overlay) {
      if (i < at) next.set(i, e);
      else if (i >= at + rc) next.set(i + delta, e);
      else continue;
      if (next.size !== 0 && (i < at ? i : i + delta) > hi) hi = i < at ? i : i + delta;
    }
    s.overlay = next;
    s.overlayHi = hi;
  }
  for (let j = 0; j < values.length; j++) overlaySet(s, at + j, { v: values[j], assigned: true });
  return removed;
}

/**
 * Mutable draft twin of {@link ValueList}, handed out inside produce(): the
 * verbs (`set`, `push`, `splice`, …) edit in place, and the value's copying
 * edits (`with`, `pushed`, …) are what-ifs, each built from a snapshot of the
 * pending edits, O(k log n) for k of them; in a loop, `current(d.list)` once.
 */
export class DraftList<T> implements Iterable<Draft<T> | (T & undefined)> {
  declare readonly [DRAFT_STATE]: ListState<T>;

  constructor(token: symbol, state: ListState) {
    if (token !== INTERNAL) {
      throw new TypeError('valsem: DraftList instances are created by produce()');
    }
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }

  get #state(): ListState {
    const s = this[DRAFT_STATE];
    assertUnrevoked(s);
    return s;
  }

  get length(): number {
    const s = this.#state;
    return s.work.length + s.tail.length;
  }


  /**
   * The element at `index` (drafted, if it can be), as `ValueList.at` and
   * `Array.prototype.at` read it: a negative index counts from the end, and
   * one that names nothing gives `undefined`. `d.todos.at(-1)!.done = true`
   * edits.
   */
  at(index: number): Draft<T> | undefined {
    const i = atIndex(index, this.length, 'DraftList.at');
    return i === -1 ? undefined : this.get(i);
  }

  /** The first element (drafted, if it can be), or `undefined` when empty: `at(0)`. */
  first(): Draft<T> | undefined {
    return this.at(0);
  }

  /** The last element (drafted, if it can be), or `undefined` when empty: `at(-1)`, so `d.todos.last()!.done = true` edits. */
  last(): Draft<T> | undefined {
    return this.at(-1);
  }

  /**
   * The element at `index` (drafted, if it can be), which must name one: an
   * integer in `[0, length)`, or a `RangeError`, as `ValueList.get`. So
   * `d.todos.get(i).done = true` needs no `!`. `at` is the read that probes.
   *
   * The return type is `Draft<T>`, spelled so that TypeScript can still see
   * the class as covariant: `T & undefined` is `never` unless the list holds
   * `undefined` elements, where `Draft<T>` includes it already. A bare
   * conditional type here is opaque to the variance check, and
   * `ValueList<number>` stopped being a `ValueList<unknown>`.
   */
  get(index: number): Draft<T> | (T & undefined) {
    const s = this.#state;
    elementIndex(index, s.work.length + s.tail.length, 'DraftList.get');
    const e = entryAt(s, index);
    const value = e !== undefined ? e.v : s.work.get(index);
    const child = handOut(s, value);
    if (child !== value) {
      const entry: Entry = { v: child, assigned: e !== undefined && e.assigned };
      if (index < s.work.length) overlaySet(s, index, entry);
      else s.tail[index - s.work.length] = entry;
    }
    return child as Draft<T>;
  }

  set(index: number, value: T): this {
    const s = this.#state;
    const len = s.work.length + s.tail.length;
    elementIndex(index, len, 'DraftList.set');
    const current = readAt(s, index);
    if (same(current, value)) return this;
    assertAssignable(value, s);
    markChanged(s);
    s.ops.push({ t: 'set', i: index, value, old: current });
    if (index < s.work.length) overlaySet(s, index, { v: value, assigned: true });
    else s.tail[index - s.work.length] = { v: value, assigned: true };
    return this;
  }

  push(...values: T[]): number {
    const s = this.#state;
    for (const v of values) assertAssignable(v, s);
    markChanged(s);
    const len = s.work.length + s.tail.length;
    s.ops.push({ t: 'splice', i: len, rc: 0, inserted: values.slice(), removed: [] });
    for (let j = 0; j < values.length; j++) s.tail.push({ v: values[j], assigned: true });
    return len + values.length;
  }

  /** Remove and return the last element (drafted, as `get` hands it out), `undefined` when empty, as `Array.prototype.pop`. */
  pop(): Draft<T> | undefined {
    const s = this.#state;
    const len = s.work.length + s.tail.length;
    if (len === 0) return undefined;
    markChanged(s);
    const removed = readAt(s, len - 1);
    s.ops.push({ t: 'splice', i: len - 1, rc: 1, inserted: [], removed: [removed] });
    if (s.tail.length !== 0) s.tail.pop();
    else {
      s.work = s.work.popped();
      s.overlay.delete(len - 1);
    }
    return handOut(s, removed) as Draft<T>;
  }

  /** Replace `deleteCount` elements at `start` with `values` and return the removed ones (each drafted, as `get` hands it out), as `Array.prototype.splice`, with the arguments as `ValueList.toSpliced` takes them: a start that is a place in the list, a count that means "up to" or is left out, never `undefined` (D45). */
  splice(start: number): (Draft<T> | (T & undefined))[];
  splice(start: number, deleteCount: number, ...values: T[]): (Draft<T> | (T & undefined))[];
  splice(start: number, ...rest: unknown[]): (Draft<T> | (T & undefined))[] {
    const s = this.#state;
    // As ValueList.toSpliced: the start is a place in the list, the count means
    // "up to". Checked before anything moves.
    const [at, rc, values] = spliceArgs<T>(start, rest, s.work.length + s.tail.length, 'DraftList.splice');
    // (The return types are spelled as `get`'s is, so the class stays covariant to the variance check.)
    return lazyHandOut(s, spliceList(s, at, rc, values)) as (Draft<T> | (T & undefined))[];
  }

  /** Insert `value` before `index`, an integer in `[0, length]` (else a `RangeError`), as `ValueList.inserted` places it. */
  insert(index: number, value: T): this {
    const s = this.#state;
    spliceList(s, insertionIndex(index, s.work.length + s.tail.length, 'DraftList.insert'), 0, [value]);
    return this;
  }

  /** Remove the element at `index`, which must name one: an integer in `[0, length)` (else a `RangeError`). Returns it, drafted as `get` hands it out. */
  remove(index: number): Draft<T> | (T & undefined) {
    const s = this.#state;
    return handOut(s, spliceList(s, elementIndex(index, s.work.length + s.tail.length, 'DraftList.remove'), 1, [])[0]) as Draft<T> | (T & undefined);
  }

  /** Remove and return the first element (drafted, as `get` hands it out), `undefined` when empty, as `Array.prototype.shift`. */
  shift(): Draft<T> | undefined {
    const s = this.#state;
    return s.work.length + s.tail.length === 0 ? undefined : (handOut(s, spliceList(s, 0, 1, [])[0]) as Draft<T>);
  }

  /** Insert `values` at the front; the new length, as `Array.prototype.unshift`. */
  unshift(...values: T[]): number {
    const s = this.#state;
    spliceList(s, 0, 0, values);
    return s.work.length + s.tail.length;
  }

  // What does not edit answers about the VALUE this draft would be right now
  // (its snapshot, `current(draft)`), and gives back values, not drafts: `get`, `at`
  // and iteration hand out drafts. Assign the result into a slot to keep it.

  /** Elements `[start, end)` of the list as it is right now, as `ValueList.slice`: a value, not a draft. */
  slice(start?: number, end?: number): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).slice(start, end);
  }

  /** The list as it is right now, followed by `other`, as `ValueList.concat`: a value, not a draft. */
  concat(other: ValueList<T>): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).concat(other);
  }

  // The value's copying edits are what-ifs here: each answers with the
  // `ValueList` the edit would give, applied to the list as it is right now,
  // and edits nothing (D59). The draft's own verbs — `set`, `push`, `pop`,
  // `shift`, `unshift`, `insert`, `remove`, `splice` — are the edits. The
  // positions are checked here first, so a bad one is reported in this
  // draft's name and before the snapshot is built.

  /** The list as it is right now with `value` at `index` (an element, D45): a value, as `ValueList.with`. To edit, `set`. */
  with(index: number, value: T): ValueList<T> {
    elementIndex(index, this.length, 'DraftList.with');
    return (snapshotOf(this) as ValueList<T>).with(index, value);
  }

  /** The list as it is right now with `values` appended: a value, as `ValueList.pushed`. To edit, `push`. */
  pushed(...values: T[]): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).pushed(...values);
  }

  /** The list as it is right now without its last element: a value, as `ValueList.popped`. To edit, `pop`. */
  popped(): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).popped();
  }

  /** The list as it is right now without its first element: a value, as `ValueList.shifted`. To edit, `shift`. */
  shifted(): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).shifted();
  }

  /** The list as it is right now with `values` in front: a value, as `ValueList.unshifted`. To edit, `unshift`. */
  unshifted(...values: T[]): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).unshifted(...values);
  }

  /** The list as it is right now with `value` inserted before `index` (a place in it, D45): a value, as `ValueList.inserted`. To edit, `insert`. */
  inserted(index: number, value: T): ValueList<T> {
    insertionIndex(index, this.length, 'DraftList.inserted');
    return (snapshotOf(this) as ValueList<T>).inserted(index, value);
  }

  /** The list as it is right now without the element at `index` (D45): a value, as `ValueList.removed`. To edit, `remove`. */
  removed(index: number): ValueList<T> {
    elementIndex(index, this.length, 'DraftList.removed');
    return (snapshotOf(this) as ValueList<T>).removed(index);
  }

  /** The list as it is right now with `deleteCount` elements at `start` replaced by `items`, as `ValueList.toSpliced` (its checks too): a value. To edit, `splice`. */
  toSpliced(start: number): ValueList<T>;
  toSpliced(start: number, deleteCount: number, ...items: T[]): ValueList<T>;
  toSpliced(start: number, ...rest: unknown[]): ValueList<T> {
    const [at, count, items] = spliceArgs<T>(start, rest, this.length, 'DraftList.toSpliced');
    return (snapshotOf(this) as ValueList<T>)._spliceItems(at, count, items);
  }

  // The functional reads do not draft: their callbacks get values (a drafted
  // child as the value it would be right now, `current(child)`) and the draft
  // as the third argument, and `map` and `filter` give back a `ValueList`.
  // `find` is the exception that is the point of it: the hit comes back as
  // `get` would hand it out, so `d.todos.find((t) => t.id === id)!.done = true`
  // edits, and drafts one element.

  /** The elements as values, nothing drafted: what the functional reads walk. */
  *#values(): IterableIterator<T> {
    for (const x of this.#peek()) yield (stateOf(x) === undefined ? x : intern(snapshotOf(x))) as T;
  }

  /** A `ValueList` of `fn`'s results over the list as it is right now, as `ValueList.map`. */
  map<U>(fn: (value: T, index: number, list: DraftList<T>) => U, thisArg?: unknown): ValueList<U> {
    return (snapshotOf(this) as ValueList<T>).map((v, i) => fn.call(thisArg, v, i, this));
  }

  /** A `ValueList` of the elements `fn` accepts, as `ValueList.filter`. */
  filter<S extends T>(fn: (value: T, index: number, list: DraftList<T>) => value is S, thisArg?: unknown): ValueList<S>;
  filter(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): ValueList<T>;
  filter(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).filter((v, i) => fn.call(thisArg, v, i, this));
  }

  /** A `ValueList` of the list as it is right now, sorted, as `ValueList.toSorted`: a value, and `compare` sees values. To reorder the draft, assign it: `d.todos = castDraft(d.todos.toSorted(byId))`. */
  toSorted(compare?: (a: T, b: T) => number): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).toSorted(compare);
  }

  /** A `ValueList` of the list as it is right now, reversed, as `ValueList.toReversed`. */
  toReversed(): ValueList<T> {
    return (snapshotOf(this) as ValueList<T>).toReversed();
  }

  /** A left fold over the elements as they are right now, as `ValueList.reduce`. */
  reduce(fn: (acc: T, value: T, index: number, list: DraftList<T>) => T): T;
  reduce<U>(fn: (acc: U, value: T, index: number, list: DraftList<T>) => U, initial: U): U;
  reduce(...args: unknown[]): unknown {
    return reduceIn(this.#values(), this, true, 'DraftList.reduce', args);
  }

  /** Whether `fn` accepts any element. */
  some(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.#values(), this, true, fn as never, thisArg) !== -1;
  }

  /** Whether `fn` accepts every element. */
  every(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): boolean {
    return findIndexIn(this.#values(), this, true, fn as never, thisArg, false) === -1;
  }

  /** The first element `fn` accepts, DRAFTED if it can be, as `get` hands it out; `undefined` when there is none. `fn` sees values. */
  find(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): Draft<T> | undefined {
    const i = findIndexIn(this.#values(), this, true, fn as never, thisArg);
    return i === -1 ? undefined : this.get(i);
  }

  /** The index of the first element `fn` accepts, or -1. */
  findIndex(fn: (value: T, index: number, list: DraftList<T>) => unknown, thisArg?: unknown): number {
    return findIndexIn(this.#values(), this, true, fn as never, thisArg);
  }

  /**
   * Visit every element in index order, each drafted if it can be, as `get`
   * hands it out: `d.todos.forEach((t) => { t.done = true; })` edits. As
   * `Array.prototype.forEach`: the length is read once, so an element pushed
   * during the walk is not visited (the iterator is the live one).
   */
  forEach(fn: (value: Draft<T> | (T & undefined), index: number, list: DraftList<T>) => void, thisArg?: unknown): void {
    const n = this.length;
    for (let i = 0; i < n && i < this.length; i++) fn.call(thisArg, this.get(i), i, this);
  }

  /**
   * The elements in index order, each drafted if it can be, as `get` hands it
   * out: `for (const t of d.todos) t.done = true` edits. By index and live, as
   * an `Array`'s iterator is, so it sees what the loop body pushes or removes.
   * A walk that only reads is cheaper over `current(d.todos)` or `slice()`,
   * which draft nothing.
   */
  *[Symbol.iterator](): IterableIterator<Draft<T> | (T & undefined)> {
    for (let i = 0; i < this.length; i++) yield this.get(i);
  }

  /** The elements as they are held, nothing drafted: what inspection walks. */
  *#peek(): IterableIterator<unknown> {
    const s = this.#state;
    let i = 0;
    for (const x of s.work) {
      const e = s.overlay.get(i++);
      yield e !== undefined ? e.v : x;
    }
    for (const e of s.tail) yield e.v;
  }

  /** The list as it is right now as a frozen canonical array, as `ValueList.toArray`: values, not drafts. */
  toArray(): readonly T[] {
    return (snapshotOf(this) as ValueList<T>).toArray();
  }

  /**
   * What `JSON.stringify` sees: the JSON of the value this draft would be
   * right now (an array), which is `current(draft).toJSON()`. Through the
   * snapshot and not by iterating the draft: iteration hands out child
   * drafts, and a drafted element of a `[toDraft]` type of your own would
   * stringify as its draft object, not as its value. A look, not an edit.
   */
  toJSON(): T[] {
    return (snapshotOf(this) as ValueList<T>).toJSON();
  }

  /** What `console.log` shows (Node's `util.inspect`): what the draft holds right now. */
  [INSPECT](depth: number, options: InspectOptions, inspect: Inspect): string {
    return inspectDraft('DraftList', this, () => this.length, () => [...this.#peek()], depth, options, inspect);
  }
}

/** Draft `base` under `parent`. */
export function createListDraft<T>(
  base: ValueList<T>,
  parent: DraftState | undefined,
): ListState<T> {
  const state = createDraftState<ListState>({
    kind: 'list',
    parent,
    base: base as ValueList<unknown>,
    work: base as ValueList<unknown>,
    overlay: new Map(),
    overlayHi: -1,
    tail: [],
    ops: [],
    draft: null as unknown as DraftList<unknown>,
    finalize: finalizeList,
    snapshot: snapshotList,
    applyPatch: applyListPatch,
    // A path segment comes from a patch, which may come from anywhere: one
    // that names no element is a bad path (the walker's error), not a read.
    childAt: (state, segment) => {
      const s = state as ListState;
      const ok = Number.isInteger(segment) && (segment as number) >= 0 && (segment as number) < s.work.length + s.tail.length;
      return ok ? s.draft.get(segment as number) : undefined;
    },
    replaceChild: (state, segment, value) => void (state as ListState).draft.set(segment as number, value),
  });
  state.draft = new DraftList(INTERNAL, state);
  return state as ListState<T>;
}

function applyListPatch(state: ListState, p: Patch): void {
  if (p.kind === 'list.set') state.draft.set(p.index, p.value);
  else if (p.kind === 'list.splice') {
    // A patch is an exact recorded edit, never "up to": a count that does not
    // fit means it was made against another list, and clamping it would apply
    // it "successfully" to the wrong base.
    const len = state.draft.length;
    if (
      !Number.isInteger(p.index) || p.index < 0 || p.index > len ||
      !Number.isInteger(p.remove) || p.remove < 0 || p.index + p.remove > len ||
      !Array.isArray(p.insert)
    ) {
      throw new Error(
        `valsem: a 'list.splice' patch (index ${String(p.index)}, remove ${String(p.remove)}) does not fit the list it is applied to (length ${len})`,
      );
    }
    spliceList(state, p.index, p.remove, p.insert as unknown[]); // the items as the array they are: no 150,000-argument call
  }
  else throw new Error(`valsem: cannot apply a '${p.kind}' patch to a list draft`);
}

function snapshotList(state: DraftState<ValueList<unknown>>): unknown {
  const s = state as ListState;
  const edits: [number, unknown][] = [];
  for (const [i, e] of s.overlay) edits.push([i, snapshotOf(e.v)]);
  const result = s.work._setMany(edits);
  return s.tail.length === 0 ? result : result._spliceItems(result.length, 0, s.tail.map((e) => snapshotOf(e.v)));
}

function finalizeList(
  state: ListState,
  path: PatchPath | null,
  recorder: PatchRecorder | undefined,
): unknown {
  const emitting = recorder !== undefined && path !== null;
  if (emitting) emitSeqOps(state.ops, path!, recorder);
  const edits: [number, unknown][] = [];
  // An assigned slot is described by the ops above — unless it holds a child
  // draft of THIS list: the op captured the value as assigned, and `get` then
  // drafted it (`l.set(0, c); l.get(0).y = 2`), so the edits are in no op.
  // The child says them itself, after the ops: its own patches, or a
  // `replace` if an alias finalized it first (see `resolve`).
  const slotPath = (e: Entry, i: number): PatchPath | null => {
    if (!emitting) return null;
    if (!e.assigned) return [...path!, i];
    return stateOf(e.v)?.parent === state ? [...path!, i] : null;
  };
  for (const [i, e] of state.overlay) edits.push([i, resolve(e.v, slotPath(e, i), recorder)]);
  let result = state.work._setMany(edits);
  if (state.tail.length !== 0) {
    const at = state.work.length;
    const tail = state.tail.map((e, j) => resolve(e.v, slotPath(e, at + j), recorder));
    result = result._spliceItems(result.length, 0, tail);
  }
  state.result = result;
  return result;
}
