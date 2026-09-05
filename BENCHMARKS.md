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

## The value collections vs Immutable.js

Immutable.js is the closest structural comparison — its `Map`/`Set` are
HAMTs and its `List` a 32-way radix vector, like valsem's — and the
cleanest illustration of what hash consing costs and buys. Primitive keys
and values, so intern-on-entry is a no-op and the trie/vector work is what
is timed; every row asserts both libraries agree. (`pnpm bench:collections`;
N = 10,000 unless stated.)

**Where valsem loses — every persistent update, and traversal:**

| op | valsem | Immutable | |
| --- | --- | --- | --- |
| `Map.set` existing key, novel value | 5.6 µs | 0.27 µs | 1/21× |
| `Map.set` new key | 6.5 µs | 0.23 µs | 1/28× |
| `Map.delete` | 1.6 µs | 0.21 µs | 1/7× |
| `Set.add` new member | 5.8 µs | 0.24 µs | 1/24× |
| `List.set` mid | 6.9 µs | 0.15 µs | 1/47× |
| `List.push` | 3.5 µs | 0.17 µs | 1/21× |
| build `Map` from 10k entries | 14.1 ms | 1.0 ms | 1/14× |
| build `List` from 10k elements | 0.22 ms | 0.34 ms | 1.5× |
| iterate 10k entries / members / elements | 470–790 µs | 137–182 µs | 1/3–4× |
| `get` / `has`, hit or miss | 60–70 ns | 60–70 ns | parity (2× behind at N = 100) |

**Where valsem wins — the rows the design exists for:**

| op | valsem | Immutable | |
| --- | --- | --- | --- |
| equals, two independently built equal `Map`s | **9 ns** | 544 µs | 60,000× |
| equals, two equal `Set`s | **8 ns** | 627 µs | 80,000× |
| equals, `List.from` vs push-chain | **8 ns** | 474 µs | 57,000× |
| equals, differ in one entry — cold | **9–10 ns** | 100–480 µs | 10,000–45,000× |
| equals, differ in one entry — Immutable's hashes warmed | **8–9 ns** | 29–66 ns | 4–7× |
| one update, then hash the successor | **0.4–1.1 µs** | 265–340 µs | 300–670× |
| the same rows at N = 100 | 6–18 ns | 2–4 µs (25–41 ns warmed) | 100–600× (3–5× warmed) |

The equality rows are not a faster algorithm; they are the absence of one.
Equal content is the same instance, so `deepEqual` is the `[interned]`
short-circuit and never looks inside. Read the two ≠ rows together:
Immutable caches `hashCode()` per instance and `is()` short-circuits on
cached hashes that differ, so once a pair has been hashed an *unequal*
compare is O(1) there too — the honest gap on unequal pairs is single-digit.
The gap that stays at four to five orders of magnitude is the **equal**
compare, which no hash can shortcut and Immutable must walk every time —
and that is the memo-*hit* case, the common one after an update (most
subtrees did not change). Every Immutable successor is also a fresh
instance whose hash is unpaid until first use; valsem's successor already
has its hash, because computing it was part of building the node.

**What the trade actually is.** A constant-factor update cost (~20× per
op, ~1 µs per consed node) bought an asymptotic comparison win (O(n) → O(1))
— so it pays off exactly in proportion to comparisons per mutation, and to
how often the same content recurs. It is the right trade for reducer-driven
state (one update, then memo checks across many subtrees, most of them
equal) and for anything keyed by structure. It is the wrong trade for
"fetch, build, compare once": admission is an O(n) hashing walk that costs
more than Immutable's build, and the O(1) compare then happens once. The
`===` advantage compounds with reuse; without reuse it does not exist.

**Where the update cost goes** (measured, not theorised): a persistent
update path-copies ~3 nodes, and each new node is *consed* — hashed over all
of its slots (up to 32 keys and 32 values), looked up in the pool, and
registered. `pool.register` is **~0.8 µs per node**, of which `new WeakRef`
alone is ~0.3 µs; a plain Immutable node allocation is ~40 ns. It is not
string hashing — number keys are no faster than string keys. So the
per-update tax is roughly *path length × (WeakRef + circle link + ~32-slot
rehash)*, and it is the same tax that makes every one of the equality rows
a pointer compare. Two things would narrow it without changing the
semantics: deriving a consed node's hash from its predecessor's (a
positional sum-of-terms, as records and arrays already do, instead of the
sequential `mix` chain), and a cheaper weak slot than one `WeakRef` per
node. Neither is done yet.

**Record values.** With `{ id, label, tags }` values, building a 10k map
costs 22 ms against Immutable's 1.3–2 ms — the intern-on-entry tax, paid
per record. The semantics differ there by design: valsem canonicalises and
freezes each record, so two maps built from equal-but-distinct records are
**the same instance**; Immutable stores the references, so `is()` on those
two maps is `false`.

## How the pool cleans up: the sweeper, FinalizationRegistry, and idle time

The intern pool originally used an incremental sweeper (a circular list of
bucket records walked in bounded slices on a registration-driven schedule),
chosen over a per-entry `FinalizationRegistry` on measurement. Re-testing
that choice end to end — one global registry, one cell per pooled object,
cleanup inline in the callback, no sweeper — on V8 and on JavaScriptCore
(`bun`) produced the numbers below (both pools passed the full suite).

| `ValueMap.set`, N = 10k | circle (shipped) | FinalizationRegistry |
| --- | --- | --- |
| node, synchronous loop | 4.0 µs | 3.7 µs |
| node, yielding every 1,000 ops | 1.6 µs | 1.6 µs |
| bun, synchronous loop | 1.9 µs | 1.9 µs |
| bun, yielding | 1.7 µs | 1.5 µs |

| `pool-gc-bench` churn, 100k ops, yielding | wall | max gap (post-GC) | retained after dormancy |
| --- | --- | --- | --- |
| node, circle | 36.5 ms | 1.2 ms | 2.1 MB |
| node, FinalizationRegistry | 50.1 ms | **12.0 ms** | 0 |
| bun, circle | 11.2 ms | 0.6 ms | 0.7 MB |
| bun, FinalizationRegistry | 17.3 ms | 1.6 ms | 0.7 MB |

Read together: per registration, `FinalizationRegistry` is cheaper (no
record, no link, no sweep tick) — that is the synchronous-loop edge — but a
synchronous loop never runs its cleanup at all, because finalization
callbacks are post-GC tasks that queue behind the finish line. Where they
do run, the two pools cost the same per op, and the registry's cleanup
arrives as a **storm**: one callback per dead object in a single task —
12 ms of main-thread gap after a major GC at 100k dead on V8, versus the
sweeper's bounded slices. It is 37–50 % slower in wall time under yields on
both engines. Its one clear win is dormancy on V8 (nothing retained; the
sweeper holds ~20 bytes of not-yet-visited metadata per dead entry until its
next slice).

But the storm number is a benchmark artifact of *where* the cleanup task
lands. Under a frame-shaped workload (16 ms frames, k updates per frame on a
10k `ValueMap`, only the newest version held), the registry's post-GC batch
is proportional to what the app itself allocated since the last major GC
(~150 ns per dead node) and, at ≤100 updates per frame, produced **zero**
frames over 4 ms on either pool — a 4–5 ms finalization task simply landed in
the frame's idle slack. At 1,000 updates per frame (~160k nodes/s) the
registry's 25 ms batch was no worse than the ~22 ms major-GC pauses that
dominated both pools. And since `WeakRef` targets clear only at major GC
(23 scavenges cleared none; one mark-compact cleared all), the sweeper's
registration-driven schedule was scanning live slots the whole time —
nothing was ever dead between epochs.

**What ships now is the hybrid:** the registry reports each death, the
callback only parks the dead slot on a stack (~20 ns, so even the
unavoidable post-GC task shrinks ~5×), and the bucket cleanup runs in idle
time — `requestIdleCallback` in browser windows, `setImmediate` in Node and
Bun — in bounded slices; where neither exists, inline. No live-slot
scanning, no per-registration tax, no records, nothing retained after values
die, bounded main-thread work, ~80 lines instead of ~200. Measured against
the two designs it replaces (same harnesses, same machine):

| | circle sweeper | FinalizationRegistry inline | **hybrid (shipped)** |
| --- | --- | --- | --- |
| `pool-gc-bench` churn, node, wall | 36.5 ms | 50.1 ms | **23.1 ms** |
| … max post-GC gap | 1.2 ms | 12.0 ms | 1.7 ms |
| … workingSet, wall | 28.9 ms | 40.6 ms | **16.7 ms** |
| `Map.set` 10k, node, synchronous | 5.4 µs | 4.2 µs | **4.2 µs** |
| `Set.add` 10k, node | 5.3 µs | 4.3 µs | **4.2 µs** |
| `List.push` 100, node | 3.2 µs | 1.8 µs | **1.9 µs** |
| frame loop, 100 sets/frame, node, max overrun | 3.2 ms | 3.0 ms | **1.4 ms** |
| frame loop, 1,000 sets/frame, bun, max overrun | 5.3 ms | 2.6 ms | **2.7 ms** |

One row reads worse and is not: `pool-gc-bench`'s dormancy phase (drop
everything, a few GC+yield rounds, measure what is left) shows ~7 MB
retained for 100k dead entries, against 2 MB for the sweeper and 0 for
inline finalization. That is the parked stack mid-drain — the phase samples
after ~10 event-loop turns, and 100k slots drain in ~25 `setImmediate`
slices of 4,096 — not a residue: a few turns later it is 0. The trade is
deliberate: cleanup that never becomes one long task, at the cost of
finishing a few milliseconds later.

**JavaScriptCore runs this design 2–3× faster than V8.** `Map.set` 2.0 µs
vs 5.4, `List.push` 0.7 µs vs 2.7, `List.set` 1.1 µs vs 5.3; the update gap
to Immutable narrows from 15–36× to 4–10×; the synchronous-vs-yielding
retention penalty nearly vanishes (1.9 vs 1.7 µs); and valsem's iteration
beats Immutable's there (`Map` 10k: 306 µs vs 1.01 ms). The kept-objects
cost of `WeakRef` is an engine property, not a design one.

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
| `pnpm bench:collections` | `ValueMap`/`ValueSet`/`ValueList` vs Immutable.js `Map`/`Set`/`List`: build, lookup, update, delete, iterate, hash-after-update, equality — result agreement asserted per row |
| `pnpm bench:pool` | intern-pool GC strategies (circle sweeper vs FinalizationRegistry vs threshold sweeps) |
| `node scripts/big-array-bench.mjs` | the arena of record: results held in a ring, one contender × scheduling mode per process |
| `node scripts/retention-bench.mjs` | how each library's cost moves when results are actually retained |
| `node scripts/yield-bench.mjs` | the in-job WeakRef retention effect, isolated |
| `npx bun@latest scripts/<any>.mjs` | any of the above on JavaScriptCore (`VALSEM_DIST=<dir>` points `collections-bench` at an alternative build) |

Methodology rules learned the hard way, and now baked into the scripts:
discard-the-result benchmarks flatter unfrozen libraries (their garbage
dies in the scavenger nursery — holding results raises their cost
1.5–2×); in-process scenario order cross-pollutes heaps, so the arena of
record runs one contender per process; and V8 has frozen-array cliffs
(`slice` 65×, element reads ~5×) that any library freezing its outputs
must engineer around.
