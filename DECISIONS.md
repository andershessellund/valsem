# Decisions

The design decisions behind valsem, with the reasons and the evidence. Each
entry records what was chosen, what it was chosen over, and what it cost.
The numbers quoted are the measurements at the time of the decision; the
current numbers are in [BENCHMARKS.md](BENCHMARKS.md), which `pnpm bench`
regenerates. Entries are in the order the decisions were made.

## D1. Only immutable data is a value

Plain records, arrays, primitives, symbols, the value collections, and
classes that opt in through `[equals]`/`[hashCode]` or a registration are
values. `Date`, `RegExp`, `Map`, `Set`, `TypedArray`s, and unregistered
class instances are not, and `intern`/`deepHash` reject them with an error
that names the replacement (`ValueDate`, `ValueMap`, …). `deepEqual` never
throws on a type — a non-value compares by reference — because a total
equality is what memo comparators need.

**Why.** A pooled instance is shared by every holder; one mutation would
corrupt all of them and invalidate the cached hash. Rejecting mutable types
loudly is the only way to keep "equal content is the same object" true.
**Cost.** Users wrap dates and maps. `ValueDate` exists so that wrapping a
date is `ValueDate.of(date)` with JSON parity via `toJSON`; a `ValueRegExp`
was considered and dropped for lack of a use.

## D2. One global weak pool, cleaned up in idle time

Every canonical object lives in one process-wide pool keyed by hash, held
through `WeakRef`, with a single `FinalizationRegistry` reporting deaths.
The callback only parks the dead slot; buckets are cleaned in bounded
slices under `requestIdleCallback` where it exists, `setImmediate`
otherwise, inline where neither does. The parked stack is bounded (100k).

**Why.** Three designs were measured end to end (`scripts/experiments/`):
an incremental circle sweeper, per-entry finalization inline, and this
hybrid. The registry is cheapest per registration but delivers cleanup as
one post-GC storm (12 ms at 100k dead on V8); the sweeper bounds the work
but scans live slots between epochs, since `WeakRef` targets clear only at
major GC. The hybrid took the churn benchmark from 36.5 ms (sweeper) and
50.1 ms (registry) to 23.1 ms, with a 1.7 ms maximum post-GC gap, in ~80
lines instead of ~200. **Cost.** A few milliseconds of latency before the
last dead slots are gone, and the per-node `WeakRef` (~0.3 µs) that is the
dominant term in every construction and update.

## D3. The pool index is a `Map` keyed by a 30-bit hash

A packed open-addressed array table was built and measured against `Map`.
It wins a fixed-population micro-benchmark on V8 (hits −20%, churn 2×) but
ties on real per-op sequences, loses ~10% under unbounded growth, and loses
2× on JavaScriptCore. What the exercise found instead: three quarters of
uint32 hashes fall outside V8's 31-bit Smi range, so full-hash keys are
boxed; masking to 30 bits fixed a 2× hit cost at 200k entries. `Map` stays,
with masked keys and a `slot.hash` pre-check.

## D4. Protocol symbols are global and versioned; duplicate installs are different types

`equals`, `hashCode`, `interned` and `toDraft` are `Symbol.for('valsem.<name>.v1')`.
Two copies of valsem in one process therefore agree on the protocol, but a
`ValueSet` from one copy is a different constructor from the other's and
compares unequal to it. An earlier "localization" mechanism that made
foreign instances equal was reverted: instances of different types are
different values, and pretending otherwise hid real deployment mistakes.

## D5. Temporal equality is strict

`Duration` equality is field-wise over all ten fields (`P1D` ≠ `PT24H`),
`ZonedDateTime` is epoch, time-zone id, and calendar id (an alias zone is a
different value). Normalising either would require calendar arithmetic and
would make values hash differently from how they compare. Any Temporal type
without an equality handler makes `valsem/temporal` throw at registration.

## D6. Iteration on explicit stacks

Generators with `yield*` per level cost 47–75 ns per element; explicit-stack
iterator objects cost 3–10 ns and extend the global `Iterator` so the
ES2025 helpers keep working. This took collection iteration from 3–4×
behind Immutable.js to 1.3–6.7× ahead.

## D7. Drafting is an extension point; the barrel is side-effect-free

`produce` knows plain objects and arrays; everything else, the built-in
collections included, arrives through `[toDraft]` and the `valsem/draft`
toolkit. `produce` never imports a collection, which took a `produce`-only
bundle from 13.7 KB to 8.2 KB gzipped. `sideEffects` lists only
`valsem/temporal`: listing the self-registering modules forced every barrel
import to carry them (`deepEqual` alone went from 2.9 KB to 22 KB), and
their effects only matter when their own exports are in use, in which case
the bundler keeps them anyway.

## D8. Canonical records are built in fast-properties mode and copied with `Object.assign`

Two engine facts, both measured (`record-copy` suite): an object grown one
key at a time into `{}` leaves fast-properties mode at ~20 keys on V8,
making every later read ~6× and every copy 60–150× slower, so canonical
records are built with `Object.fromEntries` (or by assignment under 16
keys, which shares the raw object's hidden class); and object spread is an
inline cache that degrades to ~100 ns per property once a site has seen
more than four shapes, which a library's single copy site always has, so
`produce` copies a draft with `Object.assign`, whose fast path keys on the
source map. The 1000-key produce arena went from 176 µs to 19 µs.

## D9. Symbols are values, and symbol keys are part of a record

A registered symbol hashes by its name; a unique one by an id assigned on
first sight and kept in the hash cache (unique symbols are valid `WeakMap`
keys). Own enumerable symbol keys are part of a record's content. Before
this, `deepEqual({ [s]: 1 }, { [s]: 2 })` was `true` — the silent wrong
answer the library exists to prevent. **Cost.** Every raw-record walk calls
`Object.getOwnPropertySymbols` (20 ns on a small object), which moved
raw-record equality from parity with fast-deep-equal to 1.2–1.4× behind.
Canonical paths do not pay it.

## D10. Canonical key order is the first spelling's, not sorted

Key order is not part of the value: equality is lookup-based and the
record hash is an order-independent sum, so sorting bought only a
deterministic layout across processes, which nothing else in valsem
promises (hashes are seeded per process). Sorting cost ~280 ns per record
at admission and forced `produce` onto a slow path whenever a recipe added
a key. Records now follow the rule `ValueMap` and `ValueSet` already had:
order is stable within a process and never meaningful.

## D11. One meta object per canonical, in a `WeakMap`, with no back-reference

Each canonical object's hash and incremental-hash accumulator live in one
`{ h, a, n }` object in a single `WeakMap` (two maps before). The first
version gave the meta a `self` reference to its owner and the GC-bound
produce arena doubled (15 → 27 µs): a `WeakMap` value that points at its
own key is an ephemeron chain the marker resolves iteratively on every
major GC. Storing the meta *on* the value as a hidden property was measured
at 5% cheaper admission and rejected: it is visible to `Reflect.ownKeys`,
descriptor-based copiers and DevTools, and needs an owner check so a copied
or proxied property is not mistaken for canonical.

## D12. Admission looks up before it copies

`intern` folds a record's hash from its interned children and matches the
pool candidate by key, building the canonical copy only on a miss. An
unchanged refetch of a 1,000-record response went from 1.5 ms to 0.82 ms;
fresh admission from 2.9 ms to 1.77 ms across D8–D12. A string-hash cache
(FIFO by total characters) was prototyped and rejected: the engine already
caches a string's own hash on the instance, so a probe on a fresh string
costs what hashing it costs below ~20 characters, and the cache lost on
fresh data and gained ~10% only on re-hashing canonical strings.

## D13. `current()` returns a canonical value

immer's `current` returns a loose copy. Here it returns exactly what
`produce` would return if the recipe ended there, so a snapshot pushed
back into the draft adopts in O(1) and compares with `===`. Kinds supply
`snapshot` on their draft state; a kind without it rejects `current()`
with an error naming the kind. `current` and `original` live in their own
module and register the core snapshots themselves, so `produce` alone
carries none of it.

## D14. `memoize` takes values, returns interned results, and owns its table

Arguments must be values (the hasher's boundary; functions and mutable
built-ins throw with the usual message), because a key resolver could
return a non-value. Results are interned, and a function returning
something `intern` would pass through unchanged is rejected, because a
mutable result shared across calls is exactly the hazard. `maxSize`
defaults to 1: the cache holds arguments and results strongly, and size 1
is the reselect default with no retention surprise. Two designs were
rejected on measurement: keying an identity `Map` on the first argument
(lodash's 13 ns path) degrades to a linear scan when many entries share a
first argument, the common selector shape; going through `HashMap.get`
costs 1.7× on hits for the generic hash and equality of the argument
array. `memoize` shares `HashMap`'s bucket table but supplies its own hash
fold and `===`-per-argument match. Its hit on canonical arguments is ~40 ns;
on raw arguments it is a structural walk, which is what skipping the
boundary costs.

## D15. `HashMap`/`HashSet` never intern; `FastMap`/`FastSet` are native

Keys matched by content and stored as given, for keys that are fresh
values every call (request objects, coordinates): no copy, no freeze, no
pool entry per novel key. For keys that are canonical, `===` already is
value equality, so `FastMap`/`FastSet` are native `Map`/`Set` subclasses
that verify canonicality while checks are on and return the native class
itself after `skipChecks()`. The interning map they replaced was slower
than both on their own ground (19 ns on canonical keys against 16; 514 ns on
raw against 303; 1,073 ns per novel insert against 432). The mutable-key
rule of every hash map applies to `HashMap`.

## D16. Two switches the user owns; nothing reads the environment

`skipChecks()` stops verifying *canonical only* arguments (`fastEquals`,
`FastMap`, `FastSet`); `skipFreezing()` stops freezing canonical records
and arrays. Both are on by default, one-way, and independent of
`NODE_ENV`: a bundler's idea of "production" is not evidence that the
answers are right, and the library must run as bare ESM in browsers. They
are separate switches because they enforce different promises with
different blast radii: a skipped check yields one wrong boolean, a skipped
freeze lets one mutation corrupt every holder. Freezing stays on by default
even though frozen arrays are slow in V8 (indexed reads 5–12×, `slice`
100×; `frozen-array` suite): the freeze *call* is free, the cost is the
frozen state in the user's own loops, and it is theirs to trade.

**Amendment (consolidated benchmark, Bun).** On JavaScriptCore the freeze
*call* is not free: `Object.freeze` walks the array, ~170 ns per element —
1.7 ms for 10,000 elements against 0.3 µs on V8 — and it dominates
canonicalising a large array there (the 10k-array produce arena runs at 2.4
ms frozen and 12 µs with `skipFreezing()` on Bun). Records freeze in
microseconds on both engines. The default stands for now, since it is the
enforcement, but on JavaScriptCore `skipFreezing()` is the difference
between usable and not for large arrays, and the hardening guide says so;
whether large arrays should be exempt from freezing by default is an open
question this finding raises.

## D17. `InternedString` stays an opaque wrapper

A `String` subclass, or registering `String` objects as values, would give
JSON parity and string methods for free — and the same footguns (`typeof`
is `'object'`, `=== 'a'` is false, React will not render it) in a form that
looks like a string. The opaque wrapper says what it is at every use site.
It gained `toJSON` for JSON parity, and, with every other value type, its
markers moved from own class fields to prototype getters over a private
field (9 ns more to construct, no own symbol properties), so a spread copy
carries no marker.

## D18. `ValueList` is a content-chunked tree

The dense radix vector made insert and remove O(n) — 8 ms at 100k
elements, regardless of position. A leaf boundary now falls after any
element whose seeded hash says so (1 in 32, runs capped at 64), and branch
runs follow the same rule on node hashes, so the shape is a function of the
content alone: hash consing still holds, equal content is one object, and
an edit re-chunks only the runs around it. Insert, remove, `concat` and
`slice` became O(log n) expected (microseconds at 100k), and
`ValueList.diff` finds the changed regions between *any* two lists,
including an independently built refetch, in O(c log n) expected — the
case no history-based structure can do. The bounds are expected on the
seeded hash, with no amortised rebuild anywhere; an RRB tree with
deterministic bounds was designed and set aside because it gives up
node-level sharing across unrelated lists, which is the refetch case.
**Cost.** Random `get` walks size tables (72 ns against 20); `set` in the
middle is 2–3× the radix vector's. The open last run lives in a tail array
so `push` and `pop` are array copies, as before. A batch of point edits
goes through `setMany`, one bottom-up pass sharing path work, which put
batched recipes at parity with the old draft.

## D19. Hardening rules

Records are their own keys: every walk enumerates own enumerable keys and
reads with `hasOwn`, `__proto__` from JSON becomes an own data property,
holes in input arrays canonicalise to `undefined`, and registry dispatch
keys on the prototype's constructor. The protocol symbols are honoured on
class instances only; on a plain record they are ordinary keys, so an own
`[interned]: true` or `[hashCode]` cannot forge canonicality. `applyPatches`
follows a path only through own keys, in-range indices, and a kind's own
`childAt` — a crafted patch could previously reach `Object.prototype` — and
type-checks keys and indices. `deepEqual` is uncapped by design and throws
`RangeError` on distinct cyclic raw inputs; admitting paths are depth-capped
with a teaching error. Hashing is seeded per process; `configureHasher`
refuses to run after the first hash.

## D20. Benchmark methodology

Results are retained where the honest regime requires it: discarded
results die in the scavenger nursery and flatter unfrozen libraries by
1.5–2×. One produce per macrotask is the number of record for update
libraries, because the spec's `AddToKeptObjects` retains every `WeakRef`
target until the end of the job and V8 clears the kept list only at
macrotask checkpoints. Fixtures are built in fast-properties mode. Suites
settle between runs (collect, drain the pool) so one suite's garbage does
not tax the next — the first consolidated run showed list rows 10× off for
that reason. Every comparison row asserts the contenders agree on the
answer. `BENCHMARKS.md` is generated from the JSON the suites write, on
Node and on Bun, and is never edited by hand.

## D21. Interning is never optional; large responses get `RawArray`

Making interning optional throughout (a flag on `produce`, on the
collections, everywhere; "canonical form without pooling") was considered
and rejected. It is feasible for `intern` and `produce` at ~1 KB, but not
for the collections without a second, structural equality implementation,
and — the real objection — it removes the guarantee rather than an
enforcement: for the values it touches, `===` on equal content is `false`
and nothing downstream can tell. The two switches (D16) only ever remove
enforcement. The pool tax it would save (~0.3–0.5 µs per new node) is not
substantially reducible either: hashing, a `WeakRef`, a map access and a
registry cell are what interning is.

The problem that motivated it — fetch 100k rows, show 100 — is solved at
the boundary instead. `RawArray.from(response)` holds the raw array and
admits elements on demand: `slice(a, b)` returns the canonical array of
that range, each element interned once and memoized per slot, so the
visible window costs 100 interns and a refetch's unchanged rows come back
`===` because they land on the same pool instances. The view is its own
value by identity (`[hashCode]` an identity hash, `[equals]` `===`, marked
`[interned]`), so it sits in canonical state as an opaque leaf; it is not a
value of its content, and it has no iteration, so every O(n) admission is
an explicit `slice()`. A Proxy that made it array-like was considered and
dropped: `Array.isArray` would be true and every walk would materialise it.
The name says what the contents are — raw, the library's word for "not yet
a value" — rather than where they came from.
