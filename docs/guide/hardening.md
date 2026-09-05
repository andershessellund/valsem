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
every supported runtime (Node ≥ 19, browsers, workers, Deno, Bun).

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
at any time. `deepEqual` is deliberately **uncapped**: it is a passive, total
query, and a cap would change verdicts on honestly deep equal structures.

Size limits are deliberately absent: admission is O(n) with no amplification,
and byte budgets belong to the transport layer (a JSON body limit), not the
value layer.

## Weak pools, bounded sweeping

The global pool holds canonical instances via `WeakRef` — values are reclaimed
by GC the moment your program stops referencing them, so interning cannot grow
memory without bound. Pool bookkeeping is swept incrementally as a bounded
constant tax on pool traffic (with a single GC-epoch sentinel as backstop):
cleanup work is proportional to use, zero when idle, with no per-entry
finalizers and no timers. The engineering behind this — and the measurements
that chose it over `FinalizationRegistry` — is recorded in the repository's
`DESIGN.md`.
