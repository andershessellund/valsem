# Hardening

valsem is designed to sit on paths that ingest foreign data — cache keys,
decoded payloads, dedup gates. Three mechanisms keep that safe.

## Seeded, flood-resistant hashing

The default leaf hash is a per-process **seeded Marvin32** (the algorithm .NET
ships for DoS-resistant string hashing), drawn from `crypto.getRandomValues`,
so an attacker cannot precompute inputs that collide into one bucket. The
32-bit hashes are for bucketing, not authentication.

For untrusted-input deployments that also worry about seed recovery via
timing, swap in a keyed PRF:

```ts
import { configureHasher, getHashSeed, type Hasher } from 'valsem';

const key = getHashSeed();
const sip: Hasher = {
  string: (s) => sipHash(key, s),
  number: (n) => sipHashNum(key, n),
};
configureHasher(sip); // once, at startup, before any hashing
```

`configureHasher` is one-shot by design: hashes are baked into interned values
and the collections' accumulators, so swapping mid-run would corrupt identity.
Web Crypto (`globalThis.crypto`) is a platform requirement — universal in
every supported runtime (Node ≥ 22, browsers, workers, Deno, Bun).

## Depth-capped admission

`intern`, `deepHash`, and `produce`'s adoption walk foreign input recursively,
so hostile (or cyclic) input would otherwise exhaust the stack. Nesting deeper
than **512** levels is rejected with a teaching error; cyclic input gets the
same teaching error instead of a bare stack overflow.

```ts
import { configureLimits } from 'valsem';

configureLimits({ maxDepth: 2000 }); // if your data is honestly that deep
```

Unlike the hasher, the cap is not baked into values — it may be reconfigured
at any time. `deepEqual` is deliberately **uncapped**: a cap would change
verdicts on honestly deep equal structures. It is total over admitted values
(nothing deeper than the cap gets through), but on raw, never-admitted input
it is an ordinary recursive walk — cyclic input, or nesting deeper than the
engine's stack, overflows the stack like any recursive comparison. Admit
untrusted data before comparing it.

Size limits are deliberately absent: admission is O(n) with no amplification,
and byte budgets belong to the transport layer (a JSON body limit), not the
value layer.

## Weak pools, idle-time cleanup

The global pool holds canonical instances via `WeakRef` — values are reclaimed
by GC the moment your program stops referencing them, so interning cannot grow
memory without bound. Pool bookkeeping is reclaimed in idle time: one global
`FinalizationRegistry` reports each death after the major GC that collects it
(the only moment anything can be dead — scavenges never clear a `WeakRef`),
the callback merely parks the dead slot, and the bucket cleanup runs under
`requestIdleCallback` (browser windows) or `setImmediate` (Node, Bun) in
bounded slices — so a large post-GC batch never becomes one long task on the
main thread. Where neither exists, cleanup runs inside the callback. The
parked stack is bounded (100k); past that, deaths are reclaimed inline until
idle time catches up. The measurements behind this choice — frame-loop,
pool-churn and collection benchmarks on V8 and JavaScriptCore — are in the
repository's `BENCHMARKS.md`.

## The two switches you own: `skipChecks()` and `skipFreezing()`

valsem enforces two promises its callers make. It **freezes** every plain
record and array it canonicalises, so the promise "nobody mutates a shared
value" is kept by the engine (a mutation throws in strict mode). And where
an API says *canonical only* — `fastEquals(a, b)`, `FastMap`, `FastSet` —
it **checks** that the caller kept that promise, because the alternative is
a silent wrong answer (`===` on a raw object is `false`, a raw key misses).

Both are on by default, everywhere, and neither consults the environment:
a bundler's idea of "production" is not evidence that your answers are
right. Turning either off is a one-way, explicit, per-process decision, made
at startup, the way Angular's `enableProdMode()` is:

```ts
import { skipChecks, skipFreezing } from 'valsem';

if (process.env.NODE_ENV === 'production') {
  skipChecks();   // fastEquals trusts its arguments; new FastMap() is a plain Map
  skipFreezing(); // canonical records and arrays are no longer frozen
}
```

**What `skipChecks()` gives up.** The checks cost a property read and a
cache probe, so the reason to skip them is principle, not speed: from then
on a raw argument at a *canonical only* call site is a silent wrong answer
instead of a thrown one — and `new FastMap()`/`new FastSet()` hand back the
native classes themselves, so those run at exactly native cost. Semantics are untouched — non-values are still
rejected, results are still canonical.

**What `skipFreezing()` buys, and costs.** Frozen arrays are slow in V8.
The freeze call itself is free (a map transition, ~0.1 µs at any size), but
the frozen *state* is not: indexed reads run 5–12× slower, `forEach` 8×,
`filter` 2–3×, `slice` and `concat` 10–150×, `JSON.stringify` 2–5×, and
that cost lands in your own loops over canonical state (`pnpm bench:frozen`;
the table is in the repository's `BENCHMARKS.md`). Records are unaffected,
and `ValueList` never pays it — its leaves are unfrozen inside a frozen
wrapper. What you give up: a mutation of a canonical value goes undetected
and corrupts every holder of that value, its cached hash, and the pool. The
immer deal applies: freeze in development and test, where a stray mutation
throws, and skip in production if plain canonical arrays sit on a hot path.
Collections and value types keep freezing their own instances (objects, at
no cost, protecting their cached hash), and drafts still copy-on-write
through an unfrozen canonical rather than write into it.

`isCanonical(value)` is the probe behind the checks — a primitive, or an
object valsem canonicalised — exposed for assertions and comparators of your
own; it is not affected by either switch.
