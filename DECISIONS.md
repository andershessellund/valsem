# Decisions

Why valsem is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected and the evidence that rejected them, and the cost accepted. When a
decision changes, its entry is rewritten and the old choice becomes a
rejected alternative; git history keeps the sequence. Entries are grouped by
topic, and the `D` numbers are stable identifiers, not an order.

How the mechanisms work is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. Numbers quoted are the measurements
at the time of the decision. The current numbers are in
[BENCHMARKS.md](BENCHMARKS.md), which `pnpm bench` regenerates; the one-off
experiments live in `scripts/experiments/`.

## The model

### D1. Only immutable data is a value

Plain records, arrays, primitives, symbols, the value collections, and
classes that opt in through `[equals]` + `[hashCode]` or a registration are
values. `Date`, `RegExp`, `Map`, `Set`, the `TypedArray`s, and unregistered
class instances are not, and `intern`/`deepHash` reject them with an error
that names the replacement (`ValueDate`, `ValueMap`, …).

**Why.** A pooled instance is shared by every holder; one mutation would
corrupt all of them and invalidate the cached hash. `Object.freeze` is not a
defence: it does not reach the internal slots of a `Date` or `Map`, it makes
a `RegExp`'s `lastIndex` read-only (so `.exec()` throws on `/g` patterns),
and it throws on any non-empty `TypedArray`, whose bytes are rewritable
through any other view over the same buffer anyway. **Rejected:**
half-support. Before removal, `HashMap.get()` silently missed on
structurally equal `Date` keys; loud rejection replaced silent wrong
answers. **Cost.** Users wrap dates and maps. `ValueDate` exists so that
wrapping a date is `ValueDate.of(date)` with JSON parity; a `ValueRegExp`
was considered and dropped for lack of a use. TypedArray support can return
gated on `buffer.immutable` once TC39's immutable-`ArrayBuffer` ships.
DESIGN.md §2.2.

### D24. `deepEqual` is total; the admitting operations throw

`deepEqual` never throws on a *type*: a non-value compares by reference.
`deepHash`, `intern`, the collections, `produce`, `memoize` and `HashMap`
keys all throw, with the shared teaching text.

**Why.** Three grounds. Principled: equality is observational
substitutability, and two distinct `Date`s are not substitutable (one
`setTime()` later they diverge), so reference equality *is* the correct
answer for mutable objects; identity comparison of unregistered class
instances inside state records is a feature. Structural: throwing belongs
where data is admitted into value-land, not in a passive query. Practical:
equality predicates sit in memo comparators and dedup gates that must not
throw on stray foreign data; every peer library is total for the same
reason. **Rejected:** throwing on incomparable input (asked directly,
answered as above). **The one hazard left,** and its fix: the correct
answer is famously surprising (`deepEqual(new Set(), new Set())` is
`false`), so comparing two distinct instances of the same mutable built-in
logs a once-per-type development warning, gated on `NODE_ENV` through
structural `globalThis` access so the module stays runtime-neutral. Loud
without throwing. DESIGN.md §3.1.

### D25. `undefined` is not a value in records; `ValueMap` keeps it

`{ a: undefined }` equals `{}`, and the canonical form drops the key.
Arrays keep `undefined` (they are positional), and `ValueMap.set(k,
undefined)` is a real entry distinct from absence.

**Why.** In a record the distinction is almost always an accident of
construction (`{ ...base, x: opts.x }`), and no wire format can express it.
In a `ValueMap` a `Map<K, V | undefined>` is a declared intent in a way a
record field never is. Model "present but intentionally empty" with `null`.
**Cost.** One deferred `Object.keys` on successful equal-record matches (the
undefined-dropping semantics needs a second key count only when a key
mapped to `undefined` exists). That is what remains of a record branch
that first paid `for…in`, a double `hasOwnProperty` and an unconditional
second pass, and was restructured against fast-deep-equal (`equality`
suite, verdict agreement asserted per pair; the corpus avoids the two
semantic divergences, `NaN` and undefined-valued keys, where valsem answers
`true` and fast-deep-equal `false`): raw arrays of 100+ elements 2.5–2.9×
faster, raw records at parity on equal walks and 1.6–1.8× faster on
unequal ones, tiny records ~1.2× behind on the `Object.keys` allocation
floor. DESIGN.md §2.3, §3.1.

### D9. Symbols are values, and symbol keys are part of a record

A registered symbol hashes by its name; a unique one by an id assigned on
first sight and kept in the hash cache. Own enumerable symbol keys are part
of a record's content. The ids are numbered process-wide (a `globalThis`
table beside the hash seed), not per module: a per-copy counter numbers
symbols in the order each install meets them, which made plain data holding
a unique symbol the one case where a shared seed did not give duplicate
installs equal hashes (D4).

**Why.** Before this, `deepEqual({ [s]: 1 }, { [s]: 2 })` was `true`, the
silent wrong answer the library exists to prevent. **Cost.** Every raw-record
walk calls `Object.getOwnPropertySymbols` (20 ns on a small object), which
moved raw-record equality from parity with fast-deep-equal to 1.2–1.4×
behind. Canonical paths do not pay it. Symbol-keyed entries vanish in JSON,
as they always have. DESIGN.md §2.6.

### D10. Canonical key order is the first spelling's, not sorted

**Why.** Key order is not part of the value: equality is lookup-based and
the record hash is an order-independent sum, so sorting bought only a
deterministic layout across processes, which nothing else in valsem
promises (hashes are seeded per process). **Rejected:** sorted keys, the
first design. Sorting cost ~280 ns per record at admission and forced
`produce` onto a slow path whenever a recipe added a key. A copy built in
the raw object's own order also shares its hidden class. Records now follow
the rule `ValueMap`/`ValueSet` already had: order is stable within a
process and never meaningful. DESIGN.md §2.4.

### D22. `-0` is normalised to `+0` at admission

`intern(-0)` returns `+0`, and so does every path that admits a primitive
into canonical state without calling `intern` (`produce`'s finalize fast
paths, through `adopt`).

**Why.** `+0` and `-0` compare and hash equal, so they are one value, but a
stored `-0` is observable (`Object.is`, `1 / x`, `toFixed`) and would let two
canonical states that are "the same value" differ visibly. Worse, pools
compare children by SameValueZero, so which sign a canonical record carried
would depend on which spelling was admitted first: history leaking into a
value. **Cost.** One `=== 0` test per admitted primitive; a signed zero
cannot be kept in canonical state. DESIGN.md §2.1.

### D5. Temporal equality is strict

`Duration` equality is field-wise over all ten fields (`P1D` ≠ `PT24H`);
`ZonedDateTime` is epoch, time-zone id and calendar id (an alias zone is a
different value). Every other Temporal kind uses its own `equals()`.

**Why.** `Duration.compare` calls `P1D` and `PT24H` equal but throws on
`P1M` vs `P30D` without a `relativeTo`, and an equality that throws cannot
back a hash table; normalising would need calendar arithmetic and would make
values hash differently from how they compare. `ZonedDateTime.equals()`
resolves link names but preserves the spelling in `timeZoneId`,
`toString()` and `toJSON()`, and the link table changes over time
(`Europe/Kiev` became a link only in 2022). Any Temporal type without an
equality handler makes `valsem/temporal` throw at registration. DESIGN.md
§5.3.

## Equality, hashing, and the pool

### D4. Protocol symbols are global and versioned; duplicate installs are different types

`equals`, `hashCode`, `interned` and `toDraft` are
`Symbol.for('valsem.<name>.v1')`; the hash seed is
`Symbol.for('valsem.hashSeed.v1')`. Two copies of valsem in one process
agree on the protocol and the seed, but a `ValueSet` from one copy is a
different constructor from the other's and compares unequal to it.

**Why.** A `Money` class written against one copy must be recognised by a
differently-versioned copy elsewhere in the dependency graph, or it would
silently fall to reference semantics; the version suffix lets an
incompatible protocol change leave older copies seeing plain unregistered
classes. **Rejected:** a "localization" mechanism that made foreign
instances equal. Instances of different types are different values, and
pretending otherwise hid real deployment mistakes. The symbols were renamed
to the `valsem.*` namespace before first publish, because cross-realm keys
are forever. DESIGN.md §5.1.

### D26. The hash is the immutability declaration

`[hashCode]` (or a registered `hashFn`) makes a class a value: hashable,
internable, a key. An equality alone makes it comparable only, and is the
only registration the mutable built-ins accept.

**Why.** A hash is only useful if it never changes, so supplying one
*declares* "no reachable mutation". **Rejected:** a separate
`{ immutable: true }` flag beside the hash. It was redundant, and under it a
class with `[equals]` + `[hashCode]` but no flag fell through `intern`
untouched and keyed a `HashMap` by reference, a silent miss. `intern` now
throws for every class it cannot pool, and `register` refuses a hash for
`Date`, `RegExp`, `Map`, `Set` and the TypedArrays. Value types are pooled
*unfrozen*: freezing a foreign type can break it, and the hash is the
author's promise. The same declaration fixes the registration: once a type
has a registered hash, `register` throws on any other pair (the identical
pair is a no-op). `register` used to replace handlers freely; after a
coarser pair, two raw instances compared equal while their canonicals,
distinct by identity and short-circuited before dispatch, did not —
equality depended on when a value was interned. **Rejected:** freezing only
after first use; it needs a write on the hashing hot path and makes the
error depend on history. A comparable-only registration is never hashed or
pooled, so it stays replaceable and upgradable. Functions get the same
no-silent-pass-through treatment at the front door: `intern(fn)`, a recipe
returning a function, and a function as a non-draftable base throw, as the
hasher always did for one nested in data. DESIGN.md §5.1.

### D27. `[interned]` is a type contract, and `deepEqual` consults canonicality

`[interned] === true` marks an *auto-interning type*: no publicly reachable
constructor, every instance canonical by construction (the collections,
`createInternPool` users). `deepEqual` concludes `false` on any
non-identical pair where either side is marked, and on any non-identical
pair where both sides are in the interner's hash cache.

**Why.** Under the type contract, same type implies both marked, so a mixed
pair is cross-kind; and two distinct canonicals are distinct values. The
check is one or two property reads, no map lookups. Measured: distinct
canonical 1000-key records 74 µs → 0.04 µs; mixed raw trees terminate at
every canonical boundary; worst-case raw-vs-raw overhead +1.3%. The
companion invariant adds one more O(1) exit: distinct precomputed
`[hashCode]`s on class instances prove inequality before a potentially O(n)
`[equals]` runs. **Rejected:** the earlier "fresh unmarked instance equals
its marked canonical" behaviour, reclassified as a contract violation (a
type exposing non-interning construction must not carry the marker).
**Deleted:** `internEqual`. It was a side-effecting predicate (its fallback
interned both arguments, freezing the caller's objects and pooling
transients no equality check can retain), and its fast paths are exactly
`deepEqual`'s canonical short-circuit; `intern(a) === intern(b)` states
adoption explicitly. On a plain record the protocol symbols are ordinary
keys, so an own `[interned]: true` cannot forge canonicality. DESIGN.md
§3.1, §4.3.

### D2. One global weak pool, cleaned up in idle time

Every canonical object lives in one process-wide pool keyed by hash, held
through `WeakRef`, with a single `FinalizationRegistry` reporting deaths.
The callback only parks the dead slot; buckets are cleaned in bounded
slices under `requestIdleCallback` where it exists, `setImmediate`
otherwise, inline where neither does. The parked stack is bounded (100k).

**Why.** Four designs were measured end to end (`scripts/experiments/`):
monolithic threshold sweeps (15–54 ms in-batch pauses), an incremental
circle sweeper (a cursor advancing around one doubly-linked list of all
bucket records on a registration-driven budget, with a GC-epoch backstop),
per-entry finalization inline, and this hybrid. The registry is cheapest
per registration but delivers cleanup as one post-GC storm (10–18 ms at
100k dead on V8); the sweeper bounds the work but scans live slots between
epochs, since `WeakRef` targets clear only at major GC, so its schedule did
nothing between GCs and its per-registration tax was the only thing it
reliably delivered. The hybrid took the churn benchmark from
36.5 ms (sweeper) and 50.1 ms (registry) to 23.1 ms, with a 1.7 ms maximum
post-GC gap, in ~80 lines instead of ~200. Two traps baked in: deref the
owner only on the removal path (owner-deref per visit cost 2.4×), and hold
the registry from a module binding (an unreferenced
`FinalizationRegistry` is collected and its callbacks silently stop).
**Cost.** A few milliseconds before the last dead slots are gone, and the
per-node `WeakRef` (~0.3 µs) that is the dominant term in every
construction and update. DESIGN.md §4.2.

### D3. The pool index is a `Map` keyed by a 30-bit hash

**Why.** A packed open-addressed array table was built and measured against
`Map`. It wins a fixed-population micro-benchmark on V8 (hits −20%, churn
2×) but ties on real per-op sequences, loses ~10% under unbounded growth,
and loses 2× on JavaScriptCore. What the exercise found instead: three
quarters of uint32 hashes fall outside V8's 31-bit Smi range, so full-hash
keys are boxed; masking to 30 bits fixed a 2× hit cost at 200k entries.
`Map` stays, with masked keys and a `slot.hash` pre-check. The slot *is*
the `WeakRef` (a subclass): zero deoptimisations, one object header less
per member. DESIGN.md §4.2.

### D48. The pool index is 64 Maps, sharded by hash

`shard = imul(hash, 0x9e3779b1) >>> 26`; each shard is the `Map` of D3,
created on first use.

**Why.** A soak run (`scripts/experiments/soak.mjs`) held millions of
canonical objects alive, which no benchmark had, and found two properties of
one large `Map`. V8 refuses a `Map` more than 2^24 entries: at 16.9M live
canonical objects `intern` threw `RangeError: Map maximum size exceeded`.
And a hash table grows by rehashing all of itself inside the `set` that
tipped it over: measured on the pool alone, with collections told apart,
1.3 ms at 131k entries, 12 ms at 1M, 29 ms at 2M, doubling with the table.
Sharded, 20M objects intern without error and no `register` takes over a
millisecond outside a collection; registration and lookup cost the same
within noise at 1k, 100k, 1M and 4M members (one multiply, a shift and an
array load per operation). The multiply is there for consumer pools: a
`[hashCode]` with its entropy in the low bits still spreads, and one that
does not spread degenerates to the single Map this replaced. Shards are
lazy because most pools are small. **Rejected:** growing the shard count
with the pool (a split is the same stall, moved), and a hand-rolled table
(D3). **Not covered:** the meta `WeakMap` of D11 is one table too, and V8
grows a `WeakMap` far more slowly than a `Map` (0.4 s at 1M keys); that is
a separate decision. DESIGN.md §4.2.

### D11. One meta object per canonical, in a `WeakMap`, with no back-reference

Each canonical object's hash and incremental-hash accumulator live in one
`{ h, a, n }` object in a single `WeakMap`.

**Why.** Two maps before; one lookup now. **Rejected:** a `self` reference
from the meta to its owner. The GC-bound produce arena doubled (15 → 27 µs):
a `WeakMap` value that points at its own key is an ephemeron chain the
marker resolves iteratively on every major GC. **Rejected:** storing the
meta *on* the value as a hidden property, measured at 5% cheaper admission.
It is visible to `Reflect.ownKeys`, descriptor-based copiers and DevTools,
and needs an owner check so a copied or proxied property is not mistaken
for canonical. DESIGN.md §3.4. Measured again at scale, and kept: D49.

### D49. The meta stays in one `WeakMap`, and its rebuild pause is documented

A soak run found that the tail latency of a large valsem process is not the
collector's but this table's. An engine rebuilds a hash table inside the one
`set` that found it full, and a `WeakMap`'s dead entries count as full until
then: with the live set constant and novel values interned under it, V8
pauses 30–55 ms once per ~65k interns at 100k live canonical records, and
700–750 ms once per ~500k at 1M (collections excluded; `_setMeta` in a CPU
profile). Every engine does it (a bare `WeakMap`, one `set`, at 1M live
keys: V8 120–380 ms, JavaScriptCore 23 ms, SpiderMonkey 28 ms), so it is
what a `WeakMap` is and not a defect to wait out.

Only plain records and arrays (and class instances interned through the
global `intern`) are in the table. Collection nodes and wrappers, and the
members of any `createInternPool`, carry their hash on the instance: a
`ValueMap` of 1M numbers under novel sets has no operation over 18 ms
outside a collection.

**Decided:** keep D11, and say in the guide what it costs and for whom:
the pause needs many *distinct* live records *and* a stream of *novel* ones.
Values that recur make nothing novel, and data that repeats is also where
interning saves most (1M rows of 10k distinct
contents: 13 MB against 290 MB plain; all distinct: 448 against 313 MB).
Below tens of thousands of distinct live records it is under a frame.

**Rejected: the meta on the object**, built and measured (a private
non-enumerable symbol holding `{ h, a, n, o }`, `o` the owner, so that a
copy or a proxy showing the property is not taken for canonical; drafts hide
it in four traps, or interning a draft recurses through its base's meta). It
removes the pause, halves the cost of interning under churn (2.37 → 1.16 µs
at 2M live), halves major-GC time and saves 7% of the heap. But a symbol
property on the *source* takes `{ ...source }` off every engine's fast path,
enumerable or not: a 5-key spread 15 → 57 ns on V8, a 20-key one 18 → 159 ns
on JavaScriptCore. That is every reducer a user writes over canonical state,
and `produce`'s own copies: the wide-record arena 2.7 → 128 µs, big-array
held 10.4 → 18.5 µs, the collection drafts +36%, memoize hits on a raw
argument +30–39% (a miss on an absent property is dearer than a miss in a
`WeakMap`). It trades the common case for the rare one, on top of what D11
already held against it. **Rejected: several capped `WeakMap`s**, newest
first: every lookup on a canonical object would probe each table, and that
lookup is the hot path (`deepHash` of a canonical child, `fastEquals`).
**Rejected: `[hashCode]` as the carrier**: one number where three are
needed, no room for an owner check, and on a plain record that symbol is
content (D9). DESIGN.md §3.4; the guide's Performance and scale page.

### D12. Admission looks up before it copies

`intern` folds a record's hash from its interned children and matches the
pool candidate by key, building the canonical copy only on a miss.

**Why.** On a hit, every refetch of unchanged data, the copy would be thrown
away. An unchanged refetch of a 1,000-record response went from 1.5 ms to
0.82 ms; fresh admission from 2.9 ms to 1.77 ms across D8–D12. **Rejected:**
a string-hash cache (FIFO by total characters). The engine already caches a
string's own hash on the instance, so a probe on a fresh string costs what
hashing it costs below ~20 characters; the cache lost on fresh data and
gained ~10% only on re-hashing canonical strings. DESIGN.md §4.1.

### D8. Canonical records are built in fast-properties mode and copied with `Object.assign`

**Why.** Two engine facts, both measured (`record-copy` suite). An object
grown one key at a time into `{}` leaves fast-properties mode at ~20 keys
on V8, making every later read ~6× and every copy 60–150× slower, so
canonical records are built with `Object.fromEntries` (or by assignment
up to 16 keys, which shares the raw object's hidden class). And object
spread is an inline cache that degrades to ~100 ns per property once a site
has seen more than four shapes, which a library's single copy site always
has, so `produce` copies a draft with `Object.assign`, whose fast path keys
on the source map. The 1000-key produce arena went from 176 µs to 19 µs.
DESIGN.md §4.1, §7.3.

### D28. Seeded leaf hashing; Web Crypto is a platform requirement

The default leaf hash is Marvin32 (the DoS-resistant family .NET ships)
seeded per process from `crypto.getRandomValues`; `configureHasher` swaps
in a keyed PRF once, at startup, and refuses to run after the first hash.
`globalThis.crypto` is required at import.

**Why.** An attacker cannot precompute colliding inputs, at ~1.0–1.4× the
cost of FNV. Hashes are baked into pooled values and consed nodes, so a
hasher swap mid-run would corrupt identity. **Rejected:** lazy seeding with
an existence check. Its error text suggested `configureHasher()` as the
escape, but the throw fired at module load, before any caller could run,
incoherent by construction. Web Crypto is universal in every supported
runtime; an exotic host without it fails at import, which is the honest
place. Hashes are process-local by design and never cross the wire.
DESIGN.md §3.3.

### D19. Hardening rules

Records are their own keys: every walk enumerates own enumerable keys and
reads with `hasOwn`, `__proto__` from JSON becomes an own data property,
holes in arrays canonicalise to `undefined` (D44), and registry dispatch
keys on the prototype's constructor. `applyPatches` follows a path only
through own keys, in-range indices, and a kind's own `childAt`, and
type-checks keys and indices. Admitting walks (`intern`, `deepHash`,
`produce`'s adopt, `current`) are depth-capped (default 512, reconfigurable
through `configureLimits`) with a teaching error; `deepEqual` is uncapped.

**Why.** A crafted patch could previously reach `Object.prototype`; hostile
or cyclic input had a stack-exhaustion lever the seeded hasher does not
close. 512 is far beyond honest data and far below engine stack limits. A
cap on `deepEqual` would change verdicts on honestly deep equal structures.
**Rejected:** size or node-count limits. Admission is O(n) with no
amplification, any default would misclassify honest large arrays, and a
byte budget belongs to the transport layer (a JSON body limit).
Implementation note: never zero the depth counter at the throw site; the
`try/finally` chain unwinds it, and doing both drove it negative and
silently disabled the guard (caught by the guard-reset test). DESIGN.md §9.

## Collections

### D29. Plain data by default; values may not lie about their kind

Records and lists are plain frozen objects and arrays; classes exist only
where JavaScript lacks the primitive (sets, value-keyed maps, ordered maps)
and then duck-type the native readonly interfaces; optimised types are
opt-ins; optimisations are invisible.

**Why.** Immutable.js had the better data structures and lost to immer
anyway, because `.get('email')`, wrapper-infected signatures and `toJS()`
tollbooths taxed every line. For data, ergonomics is the contract and
performance is the implementation. **Rejected:** a perfect array-
impersonating proxy over `ValueList` (measured: `Array.isArray` true via
the array-target trick; 86 ns per indexed element against 2 ns flat; 22 ns
iteration; `structuredClone` throws). If the facade duck-types as an array,
then either equal-looking arrays are unequal (structural equality depends
on an invisible brand) or one value has two canonical objects (the pool's
founding invariant dies). The visible wrapper is the type distinction being
honest. Representation freedom lives behind owned access paths instead.
DESIGN.md §6.1.

### D30. Encapsulated backing; the classes carry the readonly read APIs

`ValueMap` implements `ReadonlyMap`; `ValueSet` and `OrderedSet` have the
whole `ReadonlySet` read API; `OrderedMap` implements `ReadonlyMap`. The
backing tries are `#private`. `ValueSet`'s set algebra takes any iterable
and returns `ValueSet`s.

**Why.** `Object.freeze` is a no-op on `Map`/`Set` internal slots (verified:
a "frozen" backing map could be mutated, corrupting the pool), so a handed-
out backing store is a hole; encapsulation removes it instead of guarding
it, and is what let the trie swap land invisibly. Being the interface keeps
interop: pass the collection anywhere the read API is accepted, `new Map(m)`
for a mutable copy. The algebra first returned native `Set`s per the lib
signature; a value's operations should yield values, so it returns
`ValueSet`s, which is why the class cannot spell `implements ReadonlySet`
(the lib insists the algebra returns a native `Set`). Membership is decided
by this set's equality, never the argument's `has`, so a native `Set` of raw
objects matches by value. The representation-visibility rule that follows:
public exactly where the platform can enforce immutability
(`InternedString.value`, frozen arrays), private otherwise. DESIGN.md §6.2.

### D31. `ValueMap`/`ValueSet` are hash-consed CHAMP tries

Every trie node is interned in a node pool; equal content is the same root
object; the collection's hash is the root's consed hash; the wrapper is
canonicalised through a `WeakMap<root, wrapper>`.

**Why.** CHAMP canonical form (non-root arity ≥ 2, deletes inline single-
entry subtrees upward, collision nodes keep a canonical member order) makes
the shape a pure function of content, which licenses interning the nodes
themselves: equality becomes O(1), memory hits the distinct-subtree floor
process-wide, and diff becomes Δ-proportional by pointer pruning. Pinned by
fuzz suites (shuffled builds, op-walk mirrors, per-run seed variation) and a
total-collision suite under a degenerate `configureHasher`, which also
fixed a latent NaN-value pool split (predicates used `!==`; the trie and
every pool now use SameValueZero). Nodes carry their entry count, so the set
algebra merges two tries at node level, sharing by pointer wherever they
agree, at a cost proportional to the difference. **Rejected, for now:** an
adaptive flat small-map form. A ≤32-entry collection is already one root
node unless hashes share a 5-bit prefix. **Cost.** A per-node pool
transaction on every edit (D2); iteration order is content-determined and
arbitrary by design. DESIGN.md §6.3.

### D32. Keys, values, and members intern on entry

Everything a collection stores is a canonical value or primitive; probes
canonicalise, so `get`/`has`/`delete` accept any structural equal.

**Why.** Under the earlier identity membership the collections could not
keep their own canonicality promise: a raw element mutated after insert
changed its hash under the cached node hashes and split equal content into
distinct "canonical" instances (`ValueList.of(o) !== ValueList.of(o)` after
`o.a = 2`), the same silent-wrong-answer genus that expelled `Date`.
Interning at the door makes canonical-all-the-way-down an invariant: raw
structural equals converge, stored plain data is frozen, and `toArray()` is
the interned flat with `toArray()[i] === get(i)`. The identity-fidelity
objection that had kept `toArray()` uninterned only held under the replaced
semantics. DESIGN.md §6.2.

### D18. `ValueList` is a content-chunked tree

A leaf boundary falls after any element whose seeded hash says so (1 in 32,
runs capped at 64), and branch runs follow the same rule on node hashes, so
the shape is a function of the content alone.

**Why.** Hash consing needs history-independence. **Rejected:** RRB trees,
whose O(log n) concat and slice come from history-*dependent* relaxed nodes,
which break canonical shape and with it O(1) equality and pointer-pruned
diff; an RRB with deterministic bounds was designed and set aside because
it gives up node-level sharing across unrelated lists, the refetch case.
**Rejected:** the dense radix vector (Clojure's `PersistentVector`), the
first shipped backing. Shape-canonical (a function of length), but every
insert, remove, slice and concat rebuilt O(n): 8 ms at 100k elements
regardless of position. Content chunking keeps canonical shape and makes
insert, remove, `concat` and `slice` O(log n) expected (microseconds at
100k), and `ValueList.diff` finds the changed regions between *any* two
lists, an independently built refetch included, in O(c log n) expected,
which no history-based structure can do. The bounds are expected on the
seeded hash, with no amortised rebuild anywhere. **Cost.** Random `get`
walks size tables (72 ns against 20); `set` in the middle is 2–3× the radix
vector's. The open last run lives in a tail array so `push` and `pop` are
array copies. A batch of point edits goes through `setMany`, one bottom-up
pass sharing path work, which put batched recipes at parity with the old
draft. DESIGN.md §6.4.

### D33. `toArray()` over auto-materialisation; the cache laws

`ValueList.toArray()` is explicitly O(n), returns the interned flat array,
and is weakly memoised per instance; `.array` and `toMap()`/`toSet()` do
not exist. O(1)-sized caches on canonical values may be strong; O(n)-sized
caches must be evictable or must not exist.

**Why.** Interning makes values long-lived by design, so per-instance
caches inherit canonical lifetimes: sticky flats would turn an undo history
from O(n log n) into O(n²). The consumer owns the snapshot's lifetime by
holding or dropping the returned reference. Properties are O(1); methods
may cost, so the O(n) step is a method. Native `Map`/`Set` are non-values;
`new Map(m)` is the explicit mutable-copy escape. DESIGN.md §6.4.

### D45. A position is checked: not coerced, and not clamped where it names a place

A positional argument on valsem's own collections is checked by what it
names, and a failed check is a `RangeError` thrown before anything is
touched:

- **an element** (`get`, `at`, `keyAt`, `valueAt`, `set`, `setMany`,
  `remove`, on the values and their drafts, and `RawArray.get`): an integer
  in `[0, length)`. The reads return `T`, not `T | undefined`;
- **an insertion point** (`insert`, `insertAt`, and `splice`'s `start`): an
  integer in `[0, length]`, not counted from the end;
- **a range**: `slice`'s bounds are any integer or ±Infinity, with `Array`'s
  clamping whole (`slice(-3)`, `slice(0, 10)` of seven); `splice`'s count is
  an integer ≥ 0 or `Infinity` ("the rest"), clamped to what is there, and a
  negative count throws where `Array` reads it as 0: it has no meaning as an
  amount, only as a computation gone wrong;
- **a patch** is exact: a `list.set` index or a `list.splice` index and
  count that do not fit the value are refused, on a `ValueList` and on a
  plain array alike.

A non-integer (`NaN`, `1.5`, `'2'`) throws in all of them. `first()` and
`last()` have no index to get wrong and answer `undefined` when empty; a
keyed lookup (`get(key)`, `has`, `indexOf`) is a query, and a miss is an
answer.

**Why.** This reverses an earlier choice in two steps. After a fractional
index built a list of `undefined`s that was then interned, the index
arguments were made to follow `Array` exactly, `ToIntegerOrInfinity`
included, with the plain `Array` as the test oracle "for every argument
JavaScript callers can produce", and the reads answered `undefined` for
anything that was not an index. `Array`'s rules are three things, and only
one is worth inheriting.

*Coercion* is not: a `NaN` index is an upstream computation that went wrong
(`list.get(list.length / 2)` on an odd list), `Array` turns it into "index
0", and here the edit nobody chose lands in a value that is then canonical
and shared.

*Out of bounds as a quiet answer* is not either, where the argument names
one place. A position can be known valid in advance (`0 ≤ i < length`), so
an index that names nothing is a mistake in the caller, which is the
conclusion most language designers reached for indexing; a key cannot, which
is why the keyed lookups keep their `undefined` (and `ValueMap` is a
`ReadonlyMap` by contract, D30). The quiet answers were worse than
`undefined`: `remove(99)` was a silent no-op, `remove(-1)` deleted the last
element, so `list.remove(items.indexOf(x))` on a miss destroyed data, and
`ValueList.insert(99, x)` appended where `OrderedSet.insertAt(99, x)` threw.
`get` could not tell an `undefined` element from a missing one. Throwing
also buys the type: `get(i): T`, sound where TypeScript's own arrays are
not, and no `!` in a loop over `length`. To probe, compare with `length`; a
non-throwing accessor can be added at any time, the throw could not be.

*Clamping a range* is: a range has an answer wherever it points, the part of
it that exists, down to the empty list, and correct programs overshoot on
purpose: the top ten of seven, the short last page, the window past the last
row (`RawArray.slice(first, first + visible)` is that type's reason to
exist), a batch drained off a queue, "the rest". The languages that throw on
an index concede it: each ships a clamping range vocabulary beside the
strict one (`take`/`skip`, `prefix`/`dropFirst`, `limit`), and Python, which
raises on `l[99]`, made `l[2:99]` total on purpose. JavaScript has one name
for that vocabulary, `slice`. But only the *extent* of an edit is a range:
`splice`'s `start` is where a write lands, so it must exist, and counting it
from the end is where intent and an `indexOf` miss look identical; `pop()`
and `remove(length - 1)` say "the last one" without the ambiguity. On
`slice`, a read, `slice(-3)` stays. A patch is never "up to": it is a
recorded edit, and clamping one made against another base applied it
"successfully" to the wrong value.

On a plain array in a recipe, the mutators valsem intercepts (`splice`,
`fill`, `copyWithin`) check that their index arguments are integers and keep
`Array`'s bounds otherwise: the array is an `Array`, its reads are
`Array.prototype`'s own, and outside a recipe valsem is not there to
intercept anything. A required position that is missing throws like any
other non-integer (`splice()`, `copyWithin(undefined, 1)`, where `Array`
reads `undefined` as 0); an optional one left `undefined` means its default,
as to `Array`, with one exception: `splice(i, undefined, x)` throws, because `Array` coerces that count to 0 and the `ValueList` twin
reads it as "through the end", and one of the two deletes data. The check
runs before the draft is marked or copied, so a recipe that catches the
error carries on with an untouched draft. **Rejected:** `TypeError` for
non-numbers and `RangeError` for non-integers, as Temporal splits them: two
error types for one mistake, and `set` and `insertAt` already answered
`RangeError` for both. **Rejected:** negative indices in `at`, after
`Array.prototype.at`: one rule for every element accessor is worth more than
the namesake, and `last()` exists. **Cost.** Breaking for callers who relied
on any of it; and `DraftList.get`'s return type is spelled `Draft<T> | (T &
undefined)`, which is `Draft<T>` exactly, because a bare conditional type
there is opaque to TypeScript's variance check and `ValueList<number>`
stopped being a `ValueList<unknown>`. DESIGN.md §6.2, §7.2, §9.

### D23. Ordered collections find a key's position through content-derived anchors

`OrderedMap` and `OrderedSet` are insertion-ordered twins of `ValueMap` and
`ValueSet`: the value is the entry sequence, so order is part of it, and
equal sequences are one instance. Each is a `ValueList` of the keys (plus
one of the values, for the map) and a trie from key to value and
**anchor**, the first element of the key-list run the key sits in, or of
the lowest ancestor run the key does not itself start. Every operation is
O(log n) expected, and the wrapper pools on the lists alone, since the trie
is a function of them.

**Why.** A thin wrapper over a list and a map, the first design, has one
O(n) operation whichever way the layout goes, because positions shift on
delete and no persistent key-to-position index survives that.
**Rejected:** Immutable.js's representation, a key→index map over a list
with holes compacted by a size rule. It depends on delete history, which
hash consing cannot allow: two equal maps would be different objects.
**Rejected:** per-node key summaries (a `ValueSet` of the keys under each
list node), O(log n) and canonical but one to three copies of the key set.
**Rejected:** per-key absolute paths; an edit shifts the kid indices of
everything after it. Anchors are the relative form: a run's first element
is fixed by the element before it, so an edit inside a run moves no anchor,
and a boundary flip moves only the direct anchors of the runs it merged or
split. The list reports the nodes an operation consed (`ValueList._record`),
and their non-first kids are exactly the anchors that may have changed.

**Measured** (Node, 10k string keys, isolated; the benchmark suite's numbers
are higher because its synchronous loop retains every dereferenced `WeakRef`
target to the end of the job). A delete costs ~29 µs: two list removals
~13 µs, 118 anchor contributions of which ~8 change (~8 µs of no-op lookups,
~12 µs of trie path copies), `indexOf` 0.5 µs. Append ~9 µs, set on a present
key ~8 µs, `indexOf` ~0.5 µs against Immutable's 309 µs scan, iteration
276 µs against 385 µs, equality 22 ns against 648 µs. Immutable's
`OrderedMap` deletes in ~0.5 µs; the 60× is the constant-factor trade every
valsem update pays (D2, D18), plus anchor maintenance.

**Cost.** The trie generalised from stride 1|2 to 1|2|3 (`ValueMap` grew
247 bytes minified); every `ValueList` node carries its first element and
every ordered entry one anchor slot. A member must be unique for anchors to
name it, so `ValueList.indexOf` for lists with duplicates would still need
the summaries. Patches replay the recipe's operations in order
(`omap.set`/`omap.delete`/`omap.insert`, `oset.*`) rather than a netted
delta: a key deleted and set back to the same value moved to the end, and
`DraftMap`'s content netting would have said nothing. The draft's first
version built a working `OrderedSet` from the key list at draft creation,
an O(n) setup that put a one-edit `produce` at 3 ms on a 10k map; the draft
now applies structural ops to the base persistently as they happen.
**The anchor update, as built** (both were this entry's backlog). The
candidates an edit's consed nodes report are first cut down to the ones
that moved: a key's anchor has one contributor, the node where it starts a
non-first kid, and a collection's stored anchors are exactly those of its
key list, so whatever the *previous* list's path to the edit, its right
spine, its tail and its root imply is already in the trie, and a candidate
equal to it is dropped without a lookup (187 → 14 per middle delete at 10k
keys, 189 → 6 per `insertAt`). Any node of the previous tree states true
facts about the previous anchors, so the filter cannot drop an update that
is needed, whichever nodes it consults. What is left goes into the trie in
one batched descent (`trieSetLast`): keys grouped by hash bits, each touched
node rebuilt and consed once, the shape untouched since no entry comes or
goes. Measured in bursts on pinned hash seeds, medians of four paired runs:
`OrderedMap.delete` at 10k −28%, `insertAt` −31%, `OrderedSet.delete` −30%
on V8, −30% and −38% on JavaScriptCore; the filter is most of it (the
batched descent alone: −5% to −14%, and nothing on some seeds). 1.27 KB
minified, 0.49 KB gzipped. What remains of a delete is mostly the two list
re-chunks. From an external performance review, 2026-09-19. DESIGN.md §6.5.

### D6. Iteration on explicit stacks

**Why.** Generators with `yield*` per level cost 47–75 ns per element;
explicit-stack iterator objects cost 3–10 ns and extend the global
`Iterator` so the ES2025 helpers keep working. This took collection
iteration from 3–4× behind Immutable.js to 1.3–6.7× ahead. DESIGN.md §6.2.

### D15. `HashMap`/`HashSet` are native `Map`/`Set` behind `intern`

One mutable map keyed by value: a native `Map` of canonical keys, every key
interned on the way in. Values are stored as-is.

**Why.** Stored keys are the canonical copies, so mutating the caller's
object changes nothing, and iteration yields canonical values. The
asymmetry is the point: the `Value*` collections intern everything they
hold, so `HashMap` is the one place value keys meet *live* mutable objects
(`HashMap<Coord, HTMLElement>`, `HashMap<QueryKey, Subscription>`).
**Rejected:** a content-matched bucket table that stored keys as given (one
hash and one compare per lookup, no pool traffic). It won only on inserting
novel keys, at half the cost, and lost the property that makes a value-keyed
map safe: a stored key mutated afterwards was silently unfindable.
**Rejected:** `FastMap`/`FastSet`, native subclasses admitting canonical
keys only. The canonical check and the intern probe are the same `WeakMap`
lookup, so an interning map matches `FastMap` with checks on (20 ns against
30 on Node, 17 against 14 on Bun) and sits 4–10 ns off the native `Map` it
becomes with checks off, while answering correctly on a raw key. A consumer
who wants the last nanoseconds interns their keys and uses a native `Map`.
**Rejected:** renaming to `MutableMap`; it names the wrong axis, since a
native `Map` is equally mutable, and `HashMap` says "structural keys" to
anyone arriving from Java or Rust. **Reversed:** `HashSet`. It was first
declined under the criterion above, since a set's members are its keys,
all interned, so it holds nothing but values and is sugar over a native
`Set` fed interned members (`seen.add(intern(pos))`). It ships anyway,
for completeness as `HashMap`'s twin: a mutable set is not useless (it is
faster than `ValueSet` for build-and-query work, and gives the visited-set
idiom without an `intern` call at each site), and the pair is easier to
explain than a map without its set.
Guard for further additions: "mutable twin of a `Value*` type for
ergonomics" is a slope that ends at `MutableList`; capability, not
convenience, is the bar for new mutable surface. `memoize` keeps its
private bucket table (D14). DESIGN.md §6.6.

### D34. Type names name model kinds; mechanism names name mechanisms

`ValueMap`/`ValueSet`/`ValueList`/`ValueDate`, `OrderedMap`/`OrderedSet`;
`InternedString`, `HashMap`, `RawArray`; the operations `intern`, the pools,
the `interned` symbol.

**Why.** Interning is how valsem delivers value semantics, not what the
types are, so mechanism vocabulary belongs to operations. "List", not
"Array": names may not lie about their kind, and the class has no subscript
access. `InternedString` keeps a mechanism name because its value is the
wrapped *string*, not a distinct kind; a `Value*` name would overclaim, and
the class *is* the mechanism (a cached hash, a pooled identity). `RawArray`
says what the contents are, raw, the library's word for "not yet a value",
rather than where they came from. **Rejected:** `Intern{Map,Set,Array}`, the
original names, and `InternString` (the adjective is the grammatical form).
No DESIGN.md section: the names are the whole decision.

### D17. `InternedString` stays an opaque wrapper

**Why.** A `String` subclass, or registering `String` objects as values,
would give JSON parity and string methods for free, and the same footguns
(`typeof` is `'object'`, `=== 'a'` is false, React will not render it) in a
form that looks like a string. The opaque wrapper says what it is at every
use site. It gained `toJSON` for JSON parity, and, with every other value
type, its markers moved from own class fields to prototype getters over a
private field (9 ns more to construct, no own symbol properties), so a
spread copy carries no marker. DESIGN.md §6.7.

### D46. `JSON.stringify` sees the collections: arrays, and `[key, value]` pairs

Every collection has a `toJSON`: `ValueList`, `ValueSet`, `OrderedSet` and
`HashSet` give an array of their elements; `ValueMap`, `OrderedMap` and
`HashMap` give an array of `[key, value]` pairs; the draft twins give what
they hold at that moment, in the same shapes. Each call builds a fresh,
unfrozen plain array and keeps nothing.

**Why.** A class with `#private` state stringifies as `{}`, so
`JSON.stringify(state)` lost the contents of every collection in the tree,
without an error: the silent wrong answer the library exists to refuse, in
the one serialisation every JavaScript program reaches for (a log line, an
error report, `localStorage`, a devtools panel). The leaf value types already
had JSON parity (`ValueDate`, `InternedString`, `RawArray`: D17); the
containers were the gap, and it is closed now because after 1.0 it cannot be
closed quietly: the output of `JSON.stringify` on existing state would
change under everyone. For maps, pairs and not `{key, value}` records: pairs
are what `from()` takes, what `Object.entries` and `new Map(...)` speak, and
half the envelope on a large map, so JSON-representable content makes the
round trip through `from()` and no new vocabulary is invented.
**Rejected:** an object form when every key is a string. Keys are values; a
shape that depends on the data changes the day a map gains its first
non-string key, and a stable shape is worth more than a prettier common
case. `ValueMap.fromObject` stays a convenience constructor, not a claim
about the map's form.

It is a view, not a wire format (a non-goal; bindings own that): which
collection it was is not in the JSON, `undefined` and symbols go the way
they go in any array, and for `ValueMap`, `ValueSet` the order of the output
follows the per-process hash seed, so the same value stringifies differently
in another process. No sort can fix that: there is no total order over
arbitrary values, and ordering by hash inherits the seed. So the string is
for reading, never for comparing, keying or diffing; where order must hold,
that is what `OrderedMap` and `OrderedSet` are, and their strings are
stable. **Rejected:** `ValueList.toJSON()` returning `toArray()`'s canonical
snapshot. It looked free (already memoised, already under the cache law of
D33) and measured worse in every regime: `JSON.stringify` walks a frozen
array 1.6× slower than an unfrozen one, and 3.7× slower when the snapshot's
first-call interning is counted (100k records: 20.3 ms against 5.6 ms). A
fresh array also makes the cache law trivial: nothing is kept. **Rejected:**
a draft's `toJSON` iterating the draft (`[...this]`). Iteration hands out
child drafts, and a drafted element of a `[toDraft]` type of the user's own
stringified as its draft object, `{}`, not as its value. A draft's JSON is
`current(draft)`'s, through the snapshot (`snapshotOf`, not `current`
itself, which would pull `produce` into a `ValueList`-only bundle, D7): one
source of truth for the shapes, the result's order for the unordered
collections, and nothing to pay for an unmodified draft, whose snapshot is
its base. DESIGN.md §6.2.

### D21. Interning is never optional; large responses get `RawArray`

**Why.** Making interning optional throughout (a flag on `produce`, on the
collections; "canonical form without pooling") was considered and rejected.
It is feasible for `intern` and `produce` at ~1 KB, but not for the
collections without a second, structural equality implementation, and, the
real objection, it removes the guarantee rather than an enforcement: for
the values it touches, `===` on equal content is `false` and nothing
downstream can tell. The two switches (D16) only ever remove enforcement.
The pool tax it would save (~0.3–0.5 µs per new node) is not substantially
reducible either: hashing, a `WeakRef`, a map access and a registry cell
are what interning is.

The problem that motivated it, fetch 100k rows and show 100, is solved at
the boundary instead: `RawArray.from(response)` holds the raw array and
admits elements on demand, so the visible window costs 100 interns and a
refetch's unchanged rows come back `===`. The view is its own value by
identity (an identity `[hashCode]`, `[equals]` is `===`, marked
`[interned]`), so it sits in canonical state as an opaque leaf; it has no
iteration, so every O(n) admission is an explicit `slice()`. **Rejected:** a
Proxy that made it array-like; `Array.isArray` would be true and every walk
would materialise it. DESIGN.md §6.7.

### D14. `memoize` takes values, returns interned results, and owns its table

**Why.** Arguments must be values (the hasher's boundary), because a key
resolver could return a non-value. Results are interned, and a function
returning something `intern` refuses is rejected, because a mutable result
shared across calls is exactly the hazard. `maxSize` defaults to 1: the
cache holds arguments and results strongly, and size 1 is the reselect
default with no retention surprise. **Rejected:** keying an identity `Map`
on the first argument (lodash's 13 ns path); it degrades to a linear scan
when many entries share a first argument, the common selector shape.
**Rejected:** going through `HashMap.get`; `intern(args)` copies, pools and
freezes the tuple per call, 1.7–2.5× the hit cost, for 300 bytes of bundle.
`memoize` shares the bucket-table idea with the pool (`HashTable`, strong)
but supplies its own hash fold and a per-argument `deepEqual` against the
stored interned arguments, which is `===` on canonical input. A hit on
canonical arguments is ~40 ns; on raw arguments it is a structural walk,
which is what skipping the boundary costs. DESIGN.md §6.6.

## `produce`

### D7. Drafting is an extension point; the barrel is side-effect-free

`produce` knows plain objects and arrays; everything else, the built-in
collections included, arrives through `[toDraft]` and the `valsem/draft`
toolkit. `produce` never imports a collection. `sideEffects` lists only
`valsem/temporal`.

**Why.** A `produce`-only bundle went from 13.7 KB to 8.2 KB gzipped, and a
`ValueMap`-only bundle carries no proxies. **Rejected:** listing the
self-registering modules in `sideEffects`; it forced every barrel import to
carry them (`deepEqual` alone went from 2.9 KB to 22 KB), and their effects
only matter when their own exports are in use, in which case the bundler
keeps them anyway. `current`/`original` register the core snapshots from
their own module for the same reason. The Temporal entry stays listed: its
import registers handlers, and a tree-shaken bare import would silently
drop Temporal support. DESIGN.md §7.1, §10.

### D35. `produce` is unified with `intern`; finalize is an intern walk; pool membership is the marker

`intern(x) ≡ produce(x, () => {})`. Finalize resolves every reachable value
to canonical form and interns the changed spine. Canonical material is
recognised by the pool marker (the `[interned]` symbol or the hash cache),
never by `Object.isFrozen`.

**Why.** The unification is forced, not chosen: recipes graft foreign data
into drafts constantly (`draft.config = JSON.parse(str)`), so finalize must
already handle non-canonical subtrees, and accepting a foreign *base* costs
nothing extra. A source-level study of immer and mutative (both ~3k lines,
read in full) found one shared skeleton: lazy copy-on-write proxy drafts,
assignment maps, net patches. Both spend their cleverness avoiding a
finalize walk over the changed region; interning must walk it anyway, so
draft replacement, graft adoption and patch emission ride the walk we do
regardless, and aliased drafts converge by memoisation because the walk
interns. immer overloads `Object.freeze` as its "already processed" marker,
which is why disabling its auto-freeze makes it *slower* (up to 50× on
large states); mutative decouples tracking from freezing with per-produce
bookkeeping; pool membership is the strictly stronger third option: O(1),
global, and it would not wrongly prune frozen-but-foreign data. One marker
drives finalize skipping, draft scoping and node canonicalisation.
Coherence laws that follow: `produce(canonical, noop)` returns the same
reference, `produce(foreign, noop)` the canonical equivalent, and a recipe
whose edits net out emits zero patches. DESIGN.md §7.

### D36. Draft classes for collections, proxies for plain data

Plain records and arrays draft through revocable proxies; `ValueMap`,
`ValueSet`, `ValueList`, `OrderedMap` and `OrderedSet` draft through
hand-written classes (`DraftMap` and friends) bound per location.

**Why.** Plain syntax on plain data is non-negotiable (D29). For the
collections, method APIs give exact TypeScript types and natural mutable
verbs, and let patches record intent. **Rejected:** context-gated mutators
on the canonical classes. Interning maximises aliasing, so the same
canonical instance may sit at ten paths and `this` cannot identify a
location; ambient draft context leaks across `await`; sometimes-throwing
methods on frozen types are an API smell. Per-location wrappers dissolve
all three, and editing `draft.a` never affects `draft.b` even when `base.a
=== base.b`. Set members have no location, so draft sets are `add`/`delete`
only. Every draft is revoked when its `produce` ends. Foreign grafts stay
raw inside the recipe by default (the recipe's own material needs no
proxy), except a frozen one assigned into a slot: `d.k = c` is drafted
copy-on-write on read, so mutating through `d.k` edits a copy instead of
throwing on the frozen object (mutative's #18 family). That reaches one
level: a canonical nested inside the recipe's own raw literal (`d.k = {
inner: c }`) is read off that raw object, not off a draft, and a write
through it throws the engine's `TypeError` on the frozen `c`; proxying the
recipe's own material to catch it would undo the raw-material rule.
`draft(value)` opts material in explicitly (D42). **Decided, unbuilt:** schema-compiled accessor drafts for
closed-schema records (real `get`/`set` accessors per known field, a fixed
hidden-class shape, cached by schema content, proxy-free) with automatic
fallback to the proxy path; invisible by rule 4 of D29. DESIGN.md §7.2.

### D37. Patches are semantic operations, and `applyPatches` sits on top of `produce`

`produceWithPatches` emits a typed vocabulary (`record.set`/`delete`,
`list.set`/`splice`, `map.set`/`delete`, `set.add`/`delete`, the ordered
`omap.*`/`oset.*`, `replace`) with inverses; `applyPatches` replays them
through a recipe.

**Why.** Draft verbs are recorded as intent, so `splice(2, 1)` is one patch,
with no diff inference and no O(n·m) LCS on the produce path (immer's
proxied array patches are index-wise; neither immer nor mutative recovers
splice intent, confirmed in source). Plain arrays intercept the mutating
methods for the same reason and fall back to a net index diff only when
intent is lost (`sort`, `reverse`, `fill`, `copyWithin`, length writes).
Because everything is canonical, `applyPatches(base, patches) ===
produce(base, recipe)`, and patch values are interned on application, so
patches can come off a wire. Inverse-patch law: forward values resolve
drafts to their final canonical, restore values resolve drafts to their
base. Emission precedes result knowledge (children patch against
post-splice indices), so finalize retracts a container's entries on every
`=== base` outcome; that lives in `finalizeState`, by recorder marks, for
every kind at once, since per-kind bookkeeping missed cases (a map cleared
and refilled to equal content). Memoised finalize and aliasing do not mix
for free: an external review found `applyPatches(base, patches) !== result`
whenever one modified draft sat in two places, an original was assigned
back over its edited draft, or a value was edited after a sequence op
placed it. The repair is a `replace` below the root, emitted at a child's
home path when an alias finalized it first, and a path for a sequence's
own child drafts in assigned slots. **Rejected:** ordering the walk so home
slots resolve first; it works inside one container and not across two.
The mirror-checked property suite never generated these shapes; a second
one now does, and needs no mirror, because the laws are self-consistency.
DESIGN.md §7.5.

### D38. Incremental finalize: cached accumulators, virtual array drafts, transition memoisation, shadow copies

Canonical records and arrays carry their raw hash accumulator (D11);
finalize delta-updates it and interns the successor prehashed. Plain-array
drafts run in a virtual mode (point edits plus an appended tail over the
base; `push`/`pop`/index ops never copy; a structural op with unstable
positions materialises). Finalize memoises transitions per canonical base
(`WeakMap<base, recent { delta, WeakRef successor }>`, cap 16). Large
frozen bases copied repeatedly get an unfrozen shadow (`copyArr`), built on
the second copy.

**Why.** The incremental-finalize pass was measure-first, with the in-repo
bench built before touching code. Array hashing moved to a positional
accumulator because the chained mix could not be delta-updated. Its first
form, `Σ hash(eᵢ)·Pⁱ` with a fixed public `P`, was a security defect found
by external review: linear with known coefficients, so position subsets with
equal `Σ Pⁱ`, found offline by a birthday search, collided any two elements
under any seed or hasher, and `m` such blocks put `2^m` arrays in one
bucket. The term is now `scramble(mix(hash(i), hash(eᵢ)))`, the record form
with the position as the key: still one independent term per index, so the
delta update is unchanged, but not computable without the seed. **Rejected:**
deriving `P` from the seed; zero cost, but the structure stays linear, so
recovering the seed would reopen it. Cost: about 10% on from-scratch array
hashing, nothing measurable on `produce`. A successor
is a pure function of (base identity, exact delta), so a repeat produce
verifies O(touched) with no hash trust and builds nothing: the recurrent
arena went from 48 µs (17× behind mutative, because recognising a recurring
successor cost an O(n) copy plus a frozen-read-taxed compare) to 1.5 µs,
2× ahead, returning pooled `===` instances. Two misses on the way: the bench
discarded its results so the weakly pooled states died and every lookup
missed (real recurrence holds its states; the bench now does), and a cap of
8 thrashed against a 10-state cycle. The shadow cache first built a shadow
on the *first* copy, double-copying one-shot bases (reducer chains); it
engages on the second copy of the same base (chain scenario 47.8 → 25.9 µs).
The find of the pass: V8's `Array.prototype.slice` fast path excludes
frozen-elements arrays (229 µs vs 3.5 µs at 10k), discovered because the
profiler lied and a bisection script did not; every copy of a possibly-
canonical array is frozen-aware. Child drafting is restricted to base-
positioned values (the immer rule), which also fixed a patch/result
divergence for material drafted after an insert. **Backlog:** trie
transients for bulk collection drafts (collection drafts are overlays over
the base), mid-splice array deltas, `withPatches` overhead, the small-state
floor. DESIGN.md §7.4.

### D13. `current()` returns a canonical value

**Why.** immer's `current` returns a loose copy. Here it returns exactly
what `produce` would return if the recipe ended there, so a snapshot pushed
back into the draft adopts in O(1) and compares with `===`. Kinds supply
`snapshot` on their draft state; a kind without it rejects `current()` with
an error naming the kind. `current` and `original` live in their own module
and register the core snapshots themselves, so `produce` alone carries none
of it (D7). DESIGN.md §7.6.

### D39. Identity exists only where mutability does; recipes are synchronous

Inside a recipe the caller's own unfrozen objects alias as in plain
JavaScript (`fill` writes one object into many slots); canonical occupants
copy-on-write *per slot*. An `async` recipe is rejected with a teaching
error.

**Why.** Forced by `copyWithin` duplicating a frozen canonical into two
slots: canonicalisation collapses equal objects, so reference aliasing of
canonicals is unrepresentable. The fast-check produce suite runs one op
interpreter against both a draft and a frozenness-preserving mirror of the
canonical base (frozen nodes thaw per slot on write), with every oracle
`===`, and the mirror is thereby the executable specification:
`produce(base, ops) === intern(mirrorApply(ops))`. The suites and the
mutative corpus found five bugs: relocated base refs after tracked
`shift`/`unshift`/mid-splice were not marked `opaqued`; netted-out
sequences leaked their op patches; a read-but-unchanged child draft leaked
into the successor through the materialised copy; mutating through a read
of an assigned canonical threw a raw `TypeError`; and an `async` recipe
leaked its Promise as the result. Harness lessons recorded in the suites:
op payloads clone per insertion site (a shared instance mutated across two
passes can build a cyclic value, and the hang looked like a library bug
until traced), and `structuredClone` flattens `InternedString` leaves.
DESIGN.md §7.2, §7.7, §10.3.

### D16. Two switches the user owns; nothing reads the environment

`skipChecks()` stops verifying *canonical only* arguments (`fastEquals`);
`skipFreezing()` stops freezing canonical records and arrays. Both are on
by default, one-way, and independent of `NODE_ENV`.

**Why.** A bundler's idea of "production" is not evidence that the answers
are right, and the library must run as bare ESM in browsers. They are
separate switches because they enforce different promises with different
blast radii: a skipped check yields one wrong boolean, a skipped freeze lets
one mutation corrupt every holder. Freezing stays on by default even though
frozen arrays are slow in V8 (indexed reads 5–12×, `slice` 100×;
`frozen-array` suite): the freeze *call* is free there, the cost is the
frozen state in the user's own loops, and it is theirs to trade.
**Rejected:** a library-internal freeze escape. A temporary
`_setFreezing(false)` was A/B'd across every arena: event-driven big-array
zero, collections and recurrent zero, sync-burst big-array −9–15%, and one
regime-independent cost, ~38 ns per property on records (−21% on the
1000-key arena, where `ValueMap` is 30× faster than either setting anyway).
The phase-2 optimisations had removed every path where frozenness was
expensive, so the switch was reverted and the invariant stands without a
performance caveat. **Open question, raised by the consolidated Bun run:**
on JavaScriptCore the freeze *call* is O(n), ~170 ns per element (1.7 ms
for 10,000 elements against 0.3 µs on V8), and it dominates canonicalising
a large array there (the 10k-array produce arena runs at 2.4 ms frozen and
12 µs with `skipFreezing()`). **Decided for 1.0: freezing stays on by
default on every engine, large arrays included.** It is the enforcement
that makes shared canonical state safe to hand around, and the developer's
experience is not to be made worse because one engine freezes slowly: an
engine-dependent default, or a size threshold above which mutation silently
stops being caught, would trade a documented, avoidable cost for a rule
nobody can keep in their head. The cost is stated where a reader meets it
(the README's "Freezing, and Safari", the guide's Performance and scale page), measured per
engine by the `skip-freezing` benchmark suite (V8: the switch buys 2–3× in
the reader's own loops and nothing in valsem's operations; JavaScriptCore:
two orders of magnitude on an edit of a large plain array; SpiderMonkey:
nothing, freezing is free there), and avoidable with one call in production
or by holding large sequences in a `ValueList`. DESIGN.md §4.4.

## Packaging and publication

### D20. Benchmark methodology

Results are retained where the honest regime requires it. One produce per
macrotask is the number of record for update libraries. Fixtures are built
in fast-properties mode. Suites settle between runs. Every comparison row
asserts the contenders agree on the answer. `BENCHMARKS.md` is generated
from the JSON the suites write, on Node and on Bun, and is never edited by
hand.

**Why, each rule from a measurement that went wrong without it.**
Discarded results die in the scavenger nursery and flatter unfrozen
libraries by 1.5–2× (retention audit: mutative 3.4 → 5–7 µs, immer 3 →
6–12 µs under held results or a reducer chain, while valsem's cost was
retention-invariant). The spec's `AddToKeptObjects` retains every
`new WeakRef` target until the end of the current job and V8 clears the
kept list only at macrotask checkpoints, so a synchronous loop of 2,000
produces force-retains all 2,000 results at once (mass promotion, majors
mid-loop); this was most of an "18 µs GC lifecycle" that had first been
attributed to memory-system physics, and a strong-nursery that deferred
`WeakRef` creation was built and measured at exactly nothing before the
cause was found. Under one produce per task the plain-array gap to immer and
mutative is 2–3×, decomposed as ~6 µs copy (a cost everyone pays) + ~1.5 µs
pool + ~5 µs draft machinery; there is no code fix for in-job `WeakRef`
retention, so the answer for batch loops is one recipe per batch, or
`ValueList`. In-process scenario order corrupted numbers by whole
multiples (the first consolidated run showed list rows 10× off), hence one
scenario per process in the experiments and settling between suites. One
footnote worth keeping: the big-array benchmark's 50,000 elements are
structurally identical, so interning collapses them to one object while the
metric scores the defining feature zero. DESIGN.md §10.3.

### D40. Positioning: dedup and lineage-free equality, not update throughput

**Why.** Mutative optimises the write path; valsem optimises everything
after the write, and frontends read thousands of times per write.
Construction happens at arrival rate; duplication costs are paid at
data × UI surface × frame rate. immer and mutative already provide
*within-lineage* reference stability; valsem's claim is lineage-free: two
independent fetches of the same rows are `===`, a recomputed selector
output equals last frame's. TanStack Query's `structuralSharing` and the
withdrawn Records & Tuples proposal price the problem. The honest boundary:
never-repeating, write-dominated, never-compared data (canvas ticks,
sensor streams) pays hashing for nothing; commit at boundaries, or keep it
out of valsem. The doctrine for publishing: category, not comparison
("canonical values"); losses first; define the counter-arena (memo hit rate
on refetched data, update→detect→patch, memory under history); and a
`ValueList` win on a plain-data benchmark must never lead the marketing
(the Immutable.js trap). DESIGN.md §8.

### D41. `valsem/binding` is small and semver-covered; there is no "is this a value" probe

`valsem/binding` exports `defineRecordField` and `mutableBuiltinReason`.

**Why.** The pre-split `valsem/internal` subpath was an unstable cross-repo
seam consumed by the wire binding; a live wire. The promoted surface drops
the underscores and is covered by semver. **Rejected:** a type-level
`hasValueSemantics` probe (it existed briefly). It cannot see an instance-
field `[hashCode]` nor verify immutability; `intern` answers per instance,
and a binding learns the answer the same way: it returns the canonical
instance or throws naming what the class lacks. DESIGN.md §10.

### D42. `draft(value)` is a detached root inside the recipe's scope; there is no `finishDraft`

`draft(value)`, called inside a recipe, returns a draft of any draftable
with no location in the recipe's draft. It resolves wherever it is attached
or returned, is dropped if neither, and is revoked with the recipe.

**Why.** A recipe that brings material in from elsewhere — another store, a
signal read inside a `computed` — and wants to edit it before it has a slot
had two routes: assign first and edit through the read-back, which needs a
slot to exist, or a nested `produce`, which needs the edit to be expressible
against one base. Neither fits "read three signals, build one value,
decide where it goes". The core already models a scope as a flat set of
states (`Scope.states`; `assertAssignable` checks scope membership, not
lineage; `resolve` and `adopt` finalise a draft wherever the walk meets
it), so a second root costs the guards only: identity on a draft of this
scope, an error on one from another, pass-through for leaves. The one rule
that shifts is D36's "foreign material stays raw": raw by default, `draft`
opts in. Independence from a child draft over the same base follows from
D36's per-location wrappers and is the immer `createDraft` semantics.
**Rejected:** immer's `createDraft`/`finishDraft`, a draft whose lifetime
outlives a call. The revoke-at-scope-end rule is what the escape guarantee
rests on, and D36 already rejected ambient context that leaks across
`await`; a `computed` runs synchronously, so a `produce` inside it is a
sufficient lexical scope. DESIGN.md §7.1.

### D43. The one-recipe rule is enforced at finalize, not only at assignment

`finalizeState` throws for a state of any scope but the running one, ahead
of its memoisation.

**Why.** `assertAssignable` sees only the value assigned. A draft of an
enclosing recipe wrapped in a literal (`inner.slot = { w: outerDraft }`)
passed it, and the inner finalize then resolved the outer draft through
`adopt`: memoised, so the outer recipe's later edits were dropped without
an error and its result could collapse to the base. Finalize always runs
inside its own `produce`, so "this state's scope is the running scope" is
the whole invariant, checked in one place for every route in — slots,
pushes, collection values, replacements, detached drafts, custom kinds
calling `resolve` — with no signature change to the `valsem/draft` toolkit.
**Rejected:** walking every assigned value at assignment time; it is O(size
of the graft) per write for material finalize walks anyway. DESIGN.md §7.1.

### D44. An array element is what `arr[i]` reads; index pollution of built-in prototypes is out of scope

Every walk over an array reads `arr[i]`. A hole is therefore `undefined`,
canonical arrays are dense, and `intern`, `deepEqual` and `deepHash` agree by
construction.

**Why.** `intern`, `RawArray` and `ValueList.from` once checked own slots, so
a hole stayed `undefined` even with `Array.prototype[1] = x`; `deepEqual`
and `deepHash` did not, and an external review found that under such
pollution a sparse array was unequal to its own canonical form. Closing it
the defensive way was built and merged (#23), and taught enough to reverse
it before any release. The native copies (`slice`, spread, `Array.from`,
`map`, `for…of`) all read holes off the chain and make them own, so the
rule had to be "no bare read or native walk of a possibly-raw array,
anywhere", with helpers, a second test run under a polluted prototype, and
a probe trick to keep the cost to 6 to 20% on raw-array walks. None of it
does anything unless a prototype already carries an index property AND a
sparse array reaches valsem, which JSON cannot produce. And it protects
little then: the application reads that same array the same polluted way.
A library's duty is not to be the vector, which D19 covers; staying correct
inside a process whose built-ins are already altered is a different and
much weaker requirement that comparable libraries and Node's own threat
model leave out. **Decision.** Plain reads everywhere, including the three
older checks, which were the half-measure that made the paths disagree.
Less code than before the review, one meaning for a sparse array under all
conditions, and `intern` about 17% faster on large arrays on V8, with raw
hashing and equality 2 to 9 times faster on JavaScriptCore. **Kept:** own
keys for records (free, natural, and the realistic attack), and the
validation that stops input reaching a prototype. **Cost, stated.** In a
process with index pollution, the polluted value can enter canonical state
through a sparse array's hole. That is faithful to what all other code in
that process sees. DESIGN.md §9.

### D47. A draft as the base of `produce` stands for its current value

`produce(draft, recipe)`, `produceWithPatches(draft, …)` and
`applyPatches(draft, …)` are the same call on `current(draft)`, for every
kind of draft: the result is a value, patches are relative to that value, and
the draft given is not edited.

**Why.** Function A calls function B, both are built on `produce`, and A
hands B a piece of its draft. B is a function from value to value, and must
behave as it does anywhere else. Before this the call worked for a plain
draft by accident (the inner draft read through the outer proxy) and failed
for a collection draft, or a plain one holding one, with "DraftList has no
[hashCode] … implement [equals]", advice for a different mistake. It is
immer's rule, and the one the drafts already follow elsewhere: `toJSON`,
`slice` and the set algebra answer as the value the draft is right now.
**Rejected:** refusing a draft as a base. It is loud, but whether
`helper(d.sub)` throws would then depend on whether `helper` uses `produce`
inside, which is `helper`'s business. **Rejected:** running the recipe on the
given draft in place, "as if the inner produce were not there". It makes the
careless call work (`step(d.sub)` with the result dropped), and it makes
`produce` mutate its argument and return a live draft typed as a value: a
what-if asked twice applies twice, a result kept past the recipe is a revoked
proxy, and `produceWithPatches` has no value to be relative to. With the
snapshot rule the one way to go wrong is to drop the result, which is how
every operation on a value goes wrong. A draft is still not a value anywhere
else (`intern`, a `HashMap` key, a `memoize` argument), and the error there
now says so. **Cost.** The snapshot of the two core draft kinds no longer
tree-shakes away with `current()`: a bundle importing `produce` alone grows
by 1.2 KB minified (330 B gzipped); one that already imports `current` by
0.2 KB. DESIGN.md §7.1.

## Non-goals

Permanently out of scope: mutable built-ins as values; cycle support; wire
formats (a separate layer's job, building on `valsem/binding`); schemas
(higher layers); framework adapters (the point is needing none); size
limits at admission (D19).

## Open

Decided-but-unbuilt or undecided items, each with its entry:

- Trie transients for bulk collection drafts; mid-splice array deltas;
  `withPatches` overhead; the small-state floor (D38).
- An adaptive flat small-map form for `ValueMap`/`ValueSet` (D31), low
  urgency.
- Ordered-collection delete: skip the no-op anchor lookups and batch the
  trie update (D23).
- Schema-compiled accessor drafts for closed-schema records, proxy-free,
  with fallback to the proxy path; invisible by rule 4 of D29.
