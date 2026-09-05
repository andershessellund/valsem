// ---------------------------------------------------------------------------
// memoize — a pure function of values, remembered by content.
//
// `memoize(fn)` caches results keyed on the ARGUMENT TUPLE BY VALUE: two
// calls with structurally equal arguments are one call. Arguments must be
// values (anything `deepHash` accepts — the same boundary as everywhere else;
// functions and mutable built-ins are rejected with the usual teaching
// errors). Results are interned, so a memoized function is a pure function
// of canonical inputs to a canonical output: equal calls return the SAME
// instance, which is also what makes a mutable result impossible — a
// function returning something valsem cannot canonicalise is rejected.
//
// The cost follows the same rule as `deepEqual` and `HashMap`: a hit on
// canonical arguments is O(1) — their hash is cached and equality is `===` —
// while raw arguments are hashed and compared structurally on every call,
// so on raw data memoization only wins when the function is dearer than a
// walk of its arguments (~40 ns per node).
//
// Eviction is LRU over `maxSize` entries (default 1: "the same call as last
// time", the reselect default). The cache holds its arguments and results
// strongly, so a size-N cache pins N argument graphs — choose N knowingly.
// ---------------------------------------------------------------------------

import { deepEqual, interned as internedSym } from './deep-equal.js';
import { intern, internHash, _hashCacheHas } from './intern.js';

export interface MemoizeOptions {
  /** Entries to keep, evicted least-recently-used. Default 1; `Infinity` keeps everything. */
  maxSize?: number;
}

/** A memoized function: the original's signature plus cache control. */
export interface Memoized<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>;
  /** Drop every cached result. */
  clear(): void;
  /** Entries currently held. */
  readonly size: number;
}

interface Entry {
  hash: number;
  args: unknown[];
  result: unknown;
  newer: Entry | null; // toward the most recently used
  older: Entry | null;
}

/** Whether `intern` handed back something canonical — a value — rather than passing a non-value through. */
function isValue(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return typeof v !== 'function';
  return (v as Record<symbol, unknown>)[internedSym] === true || _hashCacheHas(v);
}

/**
 * Memoize a pure function of values: calls with structurally equal
 * arguments return the same (canonical) result without running `fn`.
 *
 * ```ts
 * const visible = memoize((todos: ValueList<Todo>, filter: Filter) =>
 *   todos.filter(matches(filter)).toArray());
 *
 * visible(state.todos, { done: false });     // runs
 * visible(state.todos, { done: false });     // O(1) hit, the same array instance
 * ```
 *
 * Arguments must be values; results must be values (they are interned).
 * `this` is passed through but is not part of the key — memoize functions
 * of their arguments only.
 */
export function memoize<F extends (...args: never[]) => unknown>(
  fn: F,
  options: MemoizeOptions = {},
): Memoized<F> {
  const maxSize = options.maxSize ?? 1;
  if (!(maxSize >= 1) || (maxSize !== Infinity && !Number.isInteger(maxSize))) {
    throw new RangeError(`valsem: memoize maxSize must be a positive integer or Infinity, got ${String(maxSize)}`);
  }
  const name = fn.name || 'the function';

  const buckets = new Map<number, Entry | Entry[]>();
  let newest: Entry | null = null;
  let oldest: Entry | null = null;
  let size = 0;

  const unlink = (e: Entry): void => {
    if (e.newer !== null) e.newer.older = e.older;
    else newest = e.older;
    if (e.older !== null) e.older.newer = e.newer;
    else oldest = e.newer;
  };
  const pushNewest = (e: Entry): void => {
    e.newer = null;
    e.older = newest;
    if (newest !== null) newest.newer = e;
    newest = e;
    if (oldest === null) oldest = e;
  };
  const sameArgs = (a: unknown[], b: unknown[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  };

  const memoized = function (this: unknown, ...args: unknown[]): unknown {
    let h = 0x6d656d;
    try {
      for (let i = 0; i < args.length; i++) {
        h = (Math.imul(h ^ internHash(args[i]), 0x9e3779b1) + i) >>> 0;
      }
    } catch (e) {
      throw new TypeError(
        `valsem: memoize — an argument of ${name} is not a value (${(e as Error).message}). ` +
          'Memoization is by value: pass data, not functions or mutable objects.',
      );
    }

    const bucket = buckets.get(h);
    if (bucket !== undefined) {
      if (Array.isArray(bucket)) {
        for (const e of bucket) {
          if (sameArgs(e.args, args)) {
            if (e !== newest) {
              unlink(e);
              pushNewest(e);
            }
            return e.result;
          }
        }
      } else if (sameArgs(bucket.args, args)) {
        if (bucket !== newest) {
          unlink(bucket);
          pushNewest(bucket);
        }
        return bucket.result;
      }
    }

    const raw = fn.apply(this, args as never[]);
    const result = intern(raw);
    if (!isValue(result)) {
      const what =
        typeof raw === 'function'
          ? 'a function'
          : `an instance of ${(raw as object).constructor?.name ?? 'an unregistered class'}`;
      throw new TypeError(
        `valsem: memoize — ${name} returned ${what}, which is not a value. ` +
          'Memoized results are interned and shared: return data, or a type valsem can canonicalise.',
      );
    }

    const e: Entry = { hash: h, args: args.map(intern), result, newer: null, older: null };
    if (bucket === undefined) buckets.set(h, e);
    else if (Array.isArray(bucket)) bucket.push(e);
    else buckets.set(h, [bucket, e]);
    pushNewest(e);
    size++;

    if (size > maxSize) {
      const victim = oldest!;
      unlink(victim);
      size--;
      const vb = buckets.get(victim.hash)!;
      if (Array.isArray(vb)) {
        const rest = vb.filter((x) => x !== victim);
        buckets.set(victim.hash, rest.length === 1 ? rest[0]! : rest);
      } else {
        buckets.delete(victim.hash);
      }
    }
    return result;
  } as unknown as Memoized<F>;

  Object.defineProperties(memoized, {
    clear: {
      value: (): void => {
        buckets.clear();
        newest = oldest = null;
        size = 0;
      },
    },
    size: { get: (): number => size },
  });
  return memoized;
}
