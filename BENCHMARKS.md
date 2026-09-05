# Benchmarks

valsem's category is **canonical values** — dedup, lineage-free `===`
equality, and free hashing — not raw update throughput. This file reports
both sides honestly: the arenas where that design costs something come
first, then the arenas it was built for. Everything here is reproducible
from `scripts/` (measured on Apple M2 Pro, Node 26, immer 11 at shipped
defaults, mutative 1.3; canonical 10k-scale bases, a novel state per op
unless stated).

## Where valsem loses

| arena | valsem | immer (no freeze) | mutative | notes |
| --- | --- | --- | --- | --- |
| 10k plain array, one edit, event-driven | **13–19 µs** | ~6 µs | ~6 µs | the honest number, one produce per macrotask with results held |
| 10k plain array, synchronous batch loop | **~27–32 µs** | ~7.5 µs | ~7.8 µs | see the WeakRef note below; batch into one recipe, or use `ValueList` |
| 3-key record churn | **1.3 µs** | 0.8 µs | 0.6 µs | small-state floor: proxy + pool lookup + hash walk |
| tiny-record `deepEqual` vs fast-deep-equal | ~1.2× behind | — | — | `Object.keys` allocation floor, ~300 ns absolute |

The plain-array gap decomposes as ~6 µs successor copy (a cost class every
copy-on-write library pays), ~1.5 µs pool machinery, and ~5 µs draft
machinery. Two structural facts set the floor:

- **In-job WeakRef retention.** The spec's `AddToKeptObjects` retains every
  `new WeakRef` target until the end of the current job, and V8 clears the
  kept list only at MACROTASK checkpoints. A synchronous loop of 2,000
  produces therefore force-retains all 2,000 80 KB results at once — mass
  promotion and major GCs mid-loop. No code fix exists; the answers are
  batching edits into one recipe, or `ValueList`.
- **The designed shape closes the gap.** The reducer chain
  `current = produce(current, …)` over `{ list: ValueList }` runs at
  **5.5 µs** — inside the unfrozen libraries' band, with canonical `===`
  results. The 10k-array row is the migration story's "before".

## Where valsem wins

| arena | valsem | immer (default) | mutative | notes |
| --- | --- | --- | --- | --- |
| 10k-entry map, one set | **3.5 µs** | 474 µs | 400 µs | their drafts copy the container; `ValueMap` copies a trie path |
| 10k-element list, set+push | **4.8 µs** | 9.6 µs | 9.0 µs | |
| 1000-key record, one set | **180 µs** | 208 µs | 208 µs | spread-copy floor is 153 µs |
| recurrent states (10 held configurations) | **1.5 µs** | 531 µs | 3.3 µs | transition memoization — and the only `===` results |
| `deepEqual`, raw arrays ≥ 100 elements | 2.5–2.9× faster than fast-deep-equal | | | |
| `deepEqual`, raw records | parity on equal walks, 1.6–1.8× faster on unequal | | | |
| `deepEqual`, canonical pairs | **20–33 ns flat**, any size | | | 9× to 1200×; this is the product |

The recurrent row is the one that matters for applications: a successor is
a pure function of (canonical base, exact delta), so a state the program
has produced before costs O(touched) — no copy, no hash walk — and comes
back **pointer-identical**.

## The arena the frontend actually runs

Update-throughput benchmarks score valsem's defining feature zero: in one
published suite, the workload's 50,000 structurally-identical array
elements intern to **one** object. The costs above buy properties no
update-throughput number shows:

- **Memo hit rate.** Refetch-equal data: reference-equality memoization
  hits 0% for the copy-on-write libraries (every fetch is a fresh graph)
  and 100% for valsem (equal content ⟹ same object).
- **Dirty checks are `===`.** "Unsaved changes", "did this subtree
  change", "is this the state we saved" — pointer compares at any size.
- **Memory under history.** Held versions share unchanged subtrees across
  the whole version graph, not just along the ancestry chain; revisited
  states (undo/redo cycles, toggles) are pointers to existing objects.
- **Hashing is free after admission.** Values carry their hash: keying a
  `HashMap`/`ValueMap` by structure costs a lookup, not a serialization.

## Reproducing

| command | measures |
| --- | --- |
| `pnpm bench:produce` | the produce arenas above (plus a held, macrotask-per-op big-array section) |
| `pnpm bench:equal` | `deepEqual` vs fast-deep-equal, raw and canonical, with verdict agreement asserted per pair |
| `pnpm bench:pool` | intern-pool GC strategies (circle sweeper vs FinalizationRegistry vs threshold sweeps) |
| `node scripts/big-array-bench.mjs` | the arena of record: results held in a ring, one contender × scheduling mode per process |
| `node scripts/retention-bench.mjs` | how each library's cost moves when results are actually retained |
| `node scripts/yield-bench.mjs` | the in-job WeakRef retention effect, isolated |

Methodology rules learned the hard way, and now baked into the scripts:
discard-the-result benchmarks flatter unfrozen libraries (their garbage
dies in the scavenger nursery — holding results raises their cost
1.5–2×); in-process scenario order cross-pollutes heaps, so the arena of
record runs one contender per process; and V8 has frozen-array cliffs
(`slice` 65×, element reads ~5×) that any library freezing its outputs
must engineer around.
