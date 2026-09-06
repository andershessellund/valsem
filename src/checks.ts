// ---------------------------------------------------------------------------
// The two switches the library user owns.
//
// valsem enforces two promises its callers make: that canonical values are
// never mutated (it freezes them), and, where an API says "canonical only",
// that the caller kept that promise (it checks). Both are on by default,
// everywhere, and neither consults the environment — a bundler's idea of
// "production" is not evidence that the answers are right. Turning either
// off is a one-way, explicit, per-process decision, made at startup, the
// way Angular's `enableProdMode()` is:
//
//   if (process.env.NODE_ENV === 'production') { skipChecks(); skipFreezing(); }
//
// What each one gives up is documented on the function. Both are read live,
// so a late call simply applies from then on.
// ---------------------------------------------------------------------------

let checks = true;
let freezing = true;

/**
 * Stop verifying the promises callers make where an API says "canonical
 * only" — `fastEquals` and `HashMap.getCanonical` then trust their
 * arguments. The checks are cheap (a property read and a cache probe), so
 * the reason to skip them is principle, not speed: a skipped check turns a
 * caught mistake into a silent wrong answer at that call site.
 */
export function skipChecks(): void {
  checks = false;
}

/**
 * Stop freezing the plain records and arrays valsem canonicalises. Frozen
 * arrays are slow in V8 — indexed reads 5×, `forEach` 8×, `slice` 100×,
 * `JSON.stringify` 2–5× (see BENCHMARKS.md) — and that cost lands in your
 * own loops over canonical state. What you give up: a mutation of a
 * canonical value, which throws in strict mode when frozen, goes undetected
 * and corrupts every holder of that value, its cached hash, and the pool.
 * The immer deal applies: freeze in development and test, skip in
 * production if canonical arrays sit on a hot path. Collections and value
 * types keep freezing their own instances (they are objects, it costs
 * nothing, and it protects their cached hash).
 */
export function skipFreezing(): void {
  freezing = false;
}

/** @internal Whether "canonical only" APIs verify their arguments. */
export function _checking(): boolean {
  return checks;
}

/** @internal Freeze plain canonical data — unless the user skipped freezing. */
export function _freeze<T extends object>(obj: T): T {
  if (freezing) Object.freeze(obj);
  return obj;
}
