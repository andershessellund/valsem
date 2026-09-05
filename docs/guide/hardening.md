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
