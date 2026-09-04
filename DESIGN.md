# valsem — Design Document

**Value semantics for JavaScript.** Structural equality, companion hashing, global
interning, canonical instances, and immutable value collections — so that `===`
*is* deep equality, equal data exists once in memory, and change detection is a
pointer comparison.

This document is the consolidated design record of the valsem project: what is
built, what is decided-but-unbuilt, the reasoning behind every major decision,
and the laws that keep the design coherent. It is intended to travel with the
project into its own repository.

---

## 1. What valsem is

valsem gives JavaScript the thing the language never had and TC39 has so far
failed to add (Records & Tuples: withdrawn): **values** — data compared by
content, not by reference.

Reduced to one sentence:

> **valsem is one operation — `(value, recipe) → canonical value` — where
> equality is `===`, cost is proportional to novelty, and everything else is
> sugar.**

Concretely:

```ts
const a = intern({ city: 'Aarhus', zip: '8000' });
const b = intern({ zip: '8000', city: 'Aarhus' });
a === b;                       // true — one frozen canonical instance

deepEqual({ x: 1 }, { x: 1 }); // true — structural
deepHash(a);                   // O(1) — cached on the canonical instance
```

Three properties arrive together and reinforce each other:

1. **Value equality is `===`.** No traversal per comparison.
2. **Hashing is O(1)** after canonicalization (cached).
3. **Sharing is automatic.** Equal subtrees are stored once, process-wide.

### 1.1 Position in the stack

valsem is the foundation layer of a larger suite, but is **independently
valuable** and is developed as a standalone project (own repo, own docs, own
audience):

| Layer | Project | Depends on |
| --- | --- | --- |
| Value semantics (this project) | `valsem` | nothing |
| Wire format (schemaless, JSON + CBOR-profile binary) | `samme` / `@sammejs/core` | valsem |
| Schemas, expression rules, IDL, UI | `@sammejs/*` | the above |
| Application runtime (spindle) | private | all of the above |

The dependency law is absolute and one-directional: **everything may depend on
valsem; valsem depends on nothing** — not on the wire format, not on any
framework, not on any runtime. `spindle`'s reactive signals dedupe via valsem's
`deepEqual`; `samme`'s decoder interns via valsem's pool. Neither is visible
from inside valsem.

valsem is the TypeScript **binding** of a language-neutral information model
(specified in the samme project). Other languages may bind the same model
without interning at all; interning is valsem's *strategy* for delivering value
semantics in JS, not part of the model.

### 1.2 Naming and packaging

- npm: **`valsem`** (unscoped flagship — the vite/svelte pattern: the package
  people type stays unscoped; constellation packages live under `@sammejs/*`).
  **Status: name verified free, NOT yet reserved. Reserve before anything
  else.**
- Repo split prerequisite: the `valsem/internal` subpath (currently consumed by
  samme: `_defineRecordField`, `_mutableBuiltinReason`, `_hasValueSemantics`)
  must be promoted to a small, semver'd **`valsem/binding`** API for
  first-party binding authors — or eliminated — before valsem and samme live in
  separate repositories. An unstable cross-repo seam is a live wire.

---

## 2. The information model: what is a value

### 2.1 The type inventory

| Kind | Host representation | Notes |
| --- | --- | --- |
| primitives | `null`, `boolean`, `number`, `string`, `bigint` | `NaN` equals `NaN`; `+0` equals `-0`; `undefined` is special (§2.3) |
| record | plain frozen object | **unordered** `key → value`; canonical form has sorted keys |
| list | plain frozen array | **ordered**; length is semantic |
| set | `InternSet` (implements `ReadonlySet`) | unordered, `===`-membered |
| map | `InternMap` (implements `ReadonlyMap`) | unordered, `===`-keyed, value-keyed |
| timestamp family | `Temporal.*` via `valsem/temporal` | eight kinds, registered immutable |
| your value types | classes via symbols / registration | §5 |

### 2.2 Mutable values are not values

`Date`, `RegExp`, native `Map`/`Set`, and the entire TypedArray family
(including `DataView`, `ArrayBuffer`) are **rejected** — `deepHash`, `intern`,
and the wire encoder all throw, each error naming the immutable replacement.
`deepEqual` alone cannot throw (it is a total function) and reports reference
semantics.

Rationale, established empirically during design:

- A canonical instance is shared by every holder; one `date.setTime()` corrupts
  all of them *and* invalidates the hash cached against it.
- `Object.freeze` is not a defense: it does not reach `Date`/`Map`/`Set`
  internal slots, it makes a `RegExp`'s `lastIndex` read-only (which makes
  `.exec()` **throw** on `/g` patterns), and it throws outright on any
  non-empty TypedArray — whose bytes are rewritable through any other view over
  the same buffer regardless.
- Half-supported mutable types were measured to be *silently broken*: before
  removal, `HashMap.get()` silently missed on structurally-equal `Date` keys.
  Loud rejection replaced silent wrong answers.

| Instead of | Use |
| --- | --- |
| `Date` | `Temporal.Instant.fromEpochMilliseconds(d.getTime())` + `valsem/temporal` |
| `RegExp` | a plain `{ source, flags }` record — a regex is behavior, not data |
| `Map` / `Set` | `InternMap` / `InternSet` |
| TypedArrays / buffers | hex/base64 strings for small binary; content-addressed blob references for large (transfer plane: HTTP, not the value model) |

The rejection table lives in one place (`deep-equal.ts`) and is shared by every
throwing surface, so one type gives one explanation wherever a user meets it.

### 2.3 `undefined` is not a value (in records)

A record is a partial function from string keys to values; **a key mapped to
`undefined` is the same record as one without the key**:

```ts
deepEqual({ a: undefined }, {});           // true
intern({ a: undefined }) === intern({});   // true — canonical form drops the key
```

The distinction is almost always an accident of construction
(`{ ...base, x: opts.x }`), and no wire format can express it. Model "present
but intentionally empty" with `null`. Two deliberate exceptions where intent is
plausible:

- **Arrays are positional**: `[undefined]` has length 1 and ≠ `[]`.
- **`InternMap` stores `undefined` deliberately**: `m.set(k, undefined)` is a
  real entry, distinct from absence (`has` distinguishes). With TypeScript, a
  `Map<K, V | undefined>` is declared intent in a way a record field never is.
  (`InternMap.fromObject` takes a *record* as input, so record semantics apply
  to it: undefined-valued keys are not carried over.)

### 2.4 Iteration order is not part of the value

Order is observable on records, `InternMap`, and `InternSet`, but never
semantic: it does not affect equality, hashing, or which canonical instance you
get. Consequence: because equal collections collapse to a single canonical
instance, the order you observe is whichever equal collection was pooled
*first* — treat it as arbitrary. (Interned records are the deterministic
exception: canonical records have sorted keys.) Hash-consed HAMT backing (§8)
will upgrade collection iteration order to content-determined. If order carries
meaning, put it in the value (a list of pairs); an order-sensitive
`OrderedMap`/`OrderedSet` may exist someday.

### 2.5 Equality is substitutability, up to canonicalization

`deepEqual(a, b)` means a and b are interchangeable everywhere *after
canonicalization*. Observable-but-nonsemantic aspects (key order, insertion
order, present-undefined) are erased by the canonical form. This is what makes
interning sound: the pool may substitute either object for the other.

---

## 3. Equality and hashing

### 3.1 `deepEqual`

Polymorphic dispatch, in order: `===` (with NaN handling) → primitives →
`Array.isArray` → the `[equals]` symbol (also the kind discriminator: mismatched
`[equals]` references are never equal) → constructor registry → plain-object
structural comparison (own enumerable string keys, undefined-valued keys
skipped, `__proto__`-safe) → reference semantics for everything else.

Total function; never throws. `NaN` equals `NaN`; `0` equals `-0`. Symbol keys
are ignored (documented). No cycle handling — values are acyclic by doctrine;
an explicit depth/size limit at decode boundaries is the (still open) DoS
backstop.

### 3.2 `deepHash` — the companion invariant

> `deepEqual(a, b)` ⟹ `deepHash(a) === deepHash(b)` — always. The converse
> never holds (collisions exist). Every equality in the system has a companion
> hash, and every new equality must ship one.

Mechanics: type tags mixed into every hash (arrays ≠ records ≠ sets with
similar content); records hash order-independently (commutative scrambled sum);
arrays order-dependently (polynomial); collections carry incremental hash state
(§3.4). Throws for anything without a hash handler — with teaching errors
(unregistered Temporal names the `valsem/temporal` import).

### 3.3 Seeded, flood-resistant leaf hashing

The default leaf hash is **Marvin32** (the DoS-resistant algorithm family .NET
ships) over UTF-16 code-unit pairs, seeded per-process from
`crypto.getRandomValues`, shared across duplicate installs via a
`Symbol.for('valsem.hashSeed.v1')` global. An attacker cannot precompute
colliding inputs. `configureHasher()` swaps in a stronger keyed PRF (e.g.
SipHash over `getHashSeed()`) — once, at startup. Hashes are **process-local by
design**: they never cross the wire, and HAMT shapes derived from them (§8) are
process-local too.

Open hardening item: seeding is currently module-load-eager (an environment
without WebCrypto throws at import, before `configureHasher` can run) — should
become lazy.

### 3.4 Incremental hashing

Collections maintain O(1)-updatable hash state:

- **Records/maps/sets**: commutative accumulator — `acc' = acc − entry(old) +
  entry(new)`. `InternMap`/`InternSet` already do this (`rollingSum`).
- **Arrays/lists**: polynomial accumulator with odd multiplier `P` (invertible
  mod 2³²): `h([a₀…aₙ]) = Σ hash(aᵢ)·Pⁱ`. Composes over concatenation:
  `hash(A ++ B) = hash(A) + P^|A| · hash(B)` — each tree node (§9) caches
  `(hash, P^size)` and computes from children in O(1).

Planned: cache the raw accumulators on canonical instances so `produce`
finalization hashes in O(changes), not O(width) (§10.3).

---

## 4. Interning: the pool

### 4.1 Mechanics

A global `Map<hash, Set<WeakRef<object>>>` plus a `WeakMap<object, hash>`
cache. `intern(value)`:

- primitives return as-is;
- objects marked `[interned]` or already in the hash cache return immediately;
- arrays and plain records are interned bottom-up (children first), then looked
  up by hash; candidates compare by `childEqual` — **SameValueZero on
  children** (`===` plus NaN-equals-NaN; plain `!==` would split the pool
  forever on NaN-containing values — a real bug found and fixed);
- registered `{ immutable: true }` types (§5) are pooled by their registered
  equality, **without freezing** (they are immutable by contract; freezing a
  foreign type can break it);
- everything else (unregistered class instances) passes through; the four
  mutable built-in families **throw**.

On a miss: the hash is cached, plain data is **frozen**, a `WeakRef` enters the
pool, and a `FinalizationRegistry` removes dead entries. The pool holds nothing
alive: canonical instances are reclaimed when unreferenced. **Interning does
not leak.**

Canonical records are rebuilt with **sorted keys** and `__proto__`-safe field
definition (a `__proto__` key from `JSON.parse` becomes an ordinary own data
property — never a prototype swap).

### 4.2 `internEqual` / `internHash`

Fast paths exploiting the pool: both-interned + `!==` ⟹ unequal; cached hashes
returned in O(1). (Known wart: `internEqual` disagrees with `deepEqual` for
non-internable values — NaN scalar aside, Dates etc. — documented as a fast
path with preconditions.)

### 4.3 `HashMap`

A mutable `Map` whose **keys** are interned on the way in — structurally equal
keys (any field order) address the same entry, because canonical keys make a
native reference-keyed `Map` sufficient. `getOrCreate` avoids the
has/get/set dance. Values are stored as-is.

---

## 5. Extension: making your own types values

Three cross-realm registered symbols (namespace `valsem.*` — these are
forever):

| Symbol | Enables | Shape |
| --- | --- | --- |
| `equals` | `deepEqual` | `[equals](other): boolean` — also the kind discriminator |
| `hashCode` | `deepHash` | number property (preferred) or method |
| `interned` | intern fast path | `true` on canonical instances |

Registry for types you cannot edit:

```ts
deepEqual.register(Type, equalsFn, hashFn, { immutable: true });
```

`{ immutable: true }` is the gate for pooling — deliberately **not implied** by
having handlers. "Immutable" means *no reachable mutation*, not "no obvious
setter": `Date` and `RegExp` are hashable and comparable and must never opt in.

`createInternPool<T>()` gives a class its own typed weak pool (canonical `===`
instances, the same deal the built-in collections get); per-class pools need no
type tags in hashes.

`valsem/temporal` (side-effect import) registers equality, hashing, and
immutability for all eight Temporal kinds. `Duration` is the documented
special case: it has no `equals()` and no total order (`compare(P1D, PT24H)` is
0; `compare(P1M, P30D)` throws), so valsem compares it **field-wise on
canonical `toString()`** — `P1D ≠ PT24H`, `PT0H = PT0M` — explicitly *not*
`Duration.compare`.

---

## 6. Collections

### 6.1 The plain-data doctrine

The Immutable.js lesson governs everything: it had the better data structures
(HAMTs!) and lost to immer anyway, because `.get('email')`, wrapper-infected
signatures, and `toJS()` tollbooths taxed every line. **For data, ergonomics is
the contract; performance is the implementation.** Four rules:

1. **Plain data by default.** Records and lists are plain frozen objects and
   arrays; `produce` edits them with plain syntax; duck typing works
   (`{ ...x, extra: 1 }` turns an X into a Y).
2. **Classes only where JavaScript lacks the primitive** — sets and value-keyed
   maps — and even then duck-typed to the native readonly interfaces.
3. **Optimized types are opt-ins**, chosen knowingly for measured hot paths
   (`InternArray`, `InternString`).
4. **Optimizations are invisible.** Same syntax, same semantics; if a user can
   tell an optimization is on other than by timing it, it's a bug.

### 6.2 `InternMap` / `InternSet`

Persistent, immutable, canonical-instance collections: two with equal contents
are the same reference, carry a precomputed `[hashCode]`, and update
persistently (`set`/`delete`/`add` return the canonical successor; pool hits
allocate nothing; incremental hashing makes successor hashes O(1)).

- **They ARE the readonly interfaces**: `InternMap implements ReadonlyMap`,
  `InternSet implements ReadonlySet` (including the ES2025 set-algebra
  methods, which return fresh native `Set`s per the standard signatures). Pass
  them anywhere those are accepted; take a mutable copy with `new Map(m)`.
- **The backing store is a `#private` field, never exposed.** JavaScript cannot
  make a `Map`/`Set` immutable at runtime (`Object.freeze` is a no-op on their
  internal slots — verified: a "frozen" backing map could be mutated, corrupting
  the pool). Encapsulation removes the hole instead of guarding it — and later
  allows the HAMT swap invisibly. Instances themselves are frozen; internal
  accumulators are `#private`.
- Entry membership is by **reference** (`===`) — intern your keys/elements
  (decode does this automatically). Fast-path pool predicates use `has()` as
  well as `get()` (stored `undefined` is legal in maps and must not alias
  absence on hash collisions — a fixed bug).

The representation-visibility rule: **`InternArray.array`/`InternString.value`
are public because frozen arrays and primitive strings are *genuinely*
enforceable; `#map`/`#set` are private because Map/Set immutability is not.**
The representation is public exactly where the platform can protect it.

### 6.3 `InternArray` / `InternString` — opt-in optimizations

`intern([1, 2])` already yields a canonical frozen `===`-comparable plain
array; strings natively have value semantics. What the wrappers add is purely
performance: O(1) incremental successor hashing on `push`/`pop`/`set`,
zero-allocation pool hits, a precomputed string hash. Accordingly they are
**opt-ins for measured hot paths, not defaults** — and on the wire they are
*hints* (`valsem.list`, `valsem.string`), not model types: a hint-blind
endpoint decodes them as the plain model value.

---

## 7. `produce` — the mutation story (designed, next to build)

### 7.1 One operation

```ts
produce(base, draft => { draft.user.email = 'x@y.dk'; draft.tags.add('vip'); });
```

`intern` is the degenerate case: `intern(x) ≡ produce(x, () => {})`. This
unification is *forced*, not chosen: recipes graft foreign data into drafts
(`draft.config = JSON.parse(str)`) constantly, so finalize must already handle
non-canonical subtrees — accepting a foreign *base* costs nothing extra. One
canonicalization engine; `adopt(x)` (or retained `intern`) is the named sugar
for the empty recipe, because intent at system boundaries deserves a name.

> **Finalize cost ∝ drafted spine + foreign material.** You pay for what you
> changed and for what isn't yet canonical — never for what is.

Coherence checks: `produce(canonical, noop)` returns the same reference;
`produce(foreign, noop)` returns the canonical equivalent;
`produceWithPatches(anything, noop)` emits **zero patches** — canonicalization
changes representation, never value.

### 7.2 Pool membership is the marker

Immer overloads `Object.freeze` as its "already processed" marker — which is
why disabling its auto-freeze makes it *slower* (up to 50× on large states):
without frozen markers it re-walks everything. Mutative decouples tracking from
freezing with private per-produce bookkeeping. valsem has the strictly stronger
third option: **pool membership** — O(1)-checkable, and *global* (a shared
subtree is skippable in every produce everywhere, forever). One marker drives
three decisions: finalize skipping, draft-wrapping (below), and later HAMT node
canonicalization.

### 7.3 Draft architecture

- **Plain records and arrays: proxies**, immer-style — plain syntax
  (`draft.a.b = 1`, `draft.rows.push(x)`), lazy copy-on-read, per-location.
  This is the non-negotiable default path (rule 1).
- **Collections: hand-written draft counterpart classes** (`DraftMap`,
  `DraftSet`, `DraftList`) — no proxies, exact TypeScript types, natural
  mutable verbs (`set`/`add`/`splice`) that native Map/Set users already write,
  so no syntax is lost. *Why not context-gated mutators on the canonical
  classes*: interning maximizes aliasing — the same canonical instance may sit
  at ten paths, so `this` cannot identify a location; ambient draft context
  leaks across `await`; sometimes-throwing methods on frozen types are an API
  smell. Draft wrappers are bound per-location, which dissolves all three.
- **Per-path semantics**: editing `draft.a` never affects `draft.b` even when
  `base.a === base.b` (interning makes such sharing common). Set members have
  no location — draft sets are `add`/`delete` only. Read-your-writes inside
  the draft. Every draft object is **revoked at finalize** (escape = throw).
- **Foreign grafts stay raw**: data the recipe just created is private —
  mutate it bare, no proxy, no protection needed (an optimization immer
  cannot make: it drafts everything it touches).
- **Patch emission**: draft verbs are *semantic operations* — `splice(2, 1)`
  is recorded as a splice, set `add`/`delete` as membership deltas — so
  `produceWithPatches` emits exact minimal wire patches with **no diff
  inference at all** (immer's proxied array patches are notoriously poor; and
  this sidesteps the O(n·m) LCS diff entirely for the produce path).
  This is what upgrades `produce` from sugar to infrastructure: a live-query
  server updating state through `produce` gets its wire deltas as a
  by-product.
- Later, invisibly (rule 4): **schema-compiled accessor drafts** for
  closed-schema records — real `get`/`set` accessors per known field, fixed
  hidden-class shape, cached by schema content-address, proxy-free — with
  automatic fallback to the proxy path for anything exotic. (The
  serializable-lambda trick — HOAS / LINQ-expression-tree style — keeps
  higher layers' constructs out of closures.)
- Adopted from Mutative: per-call options (no global config), strict-in-dev /
  loose-in-prod toggle, an explicit decision pending on async recipes (async
  is where draft escapes breed), and its `immer-non-support.test.ts` corpus as
  a free adversarial test suite.

### 7.4 Hot loops: three tiers, cheapest first

1. **Batch inside one `produce`** — drafts amortize; the pool sees one
   transaction per recipe, not per edit.
2. **Transient inside, canonical at the edges** — don't canonicalize every
   120 Hz drag tick; keep in-flight state plain/mutable and canonicalize at
   commit boundaries (drag-end, debounce, frame commit). This is the produce
   design at a larger timescale.
3. **Opt-in O(log n) structures** (§8–9) when the *committed* value is huge
   and edits are frequent.

Most applications never leave tier one.

---

## 8. Performance architecture: HAMTs and hash-consing (designed)

### 8.1 Complexity model

Finalize cost = Σ over drafted containers along changed spines (the **spine
property**: children compare `===` and have cached hashes — cost is container
*width*, never subtree size):

| Container | finalize per drafted container |
| --- | --- |
| plain record / array | O(width) — floor is the copy itself |
| HAMT-backed map/set | O(edits · log₃₂ n) |
| radix-vector list | O(edits · log₃₂ n); push ~O(1) amortized |

> **Plain data scales with depth; optimized structures scale with width.**
> Records are schema-narrow by nature (declared fields) — plain is
> asymptotically safe for them forever. Sets/maps are the model's unbounded
> collections and are already the class-typed citizens — the type system's
> plain/classed boundary coincides with the narrow/wide complexity boundary by
> construction. Lists are the one manual call (until schemas select backings).

Opt in when *width × edit-frequency* crosses the copy-cost threshold
(empirically tens-to-hundreds of elements; benchmark-gated).

### 8.2 HAMT with hash-consed nodes

`InternMap`/`InternSet` backing becomes an adaptive representation — flat
native map below ~32 entries, HAMT above — **invisibly**, behind the
encapsulated API (the payoff of §6.2's private fields). The distinctive step:
**intern the trie nodes themselves** (the pool stops being a cache in front of
the data structure and becomes the data structure):

- HAMT shape is a function of the key-hash set — history-independent — so with
  node interning, equal maps are the same nodes to the root: **equality is
  O(1)** (the O(n) pool predicate ceases to exist).
- Normalization is per-edit, worst-case bounded: each edit pools O(log₃₂ n)
  nodes; with transients (= drafts), pooling happens once at finalize for the
  changed frontier only.
- **Memory hits the distinct-subtree floor**: maximal sharing process-wide,
  weakly held, GC'd. (Pedigree: hash-consing → ROBDD unique tables → Merkle
  DAGs; `FinalizationRegistry` provides what BDD engines hand-roll.)
- **Diff becomes Δ-proportional**: pointer-pruned descent — a 100k-entry map
  with 3 changes diffs in ~3·log n. End-to-end: edit → O(Δ log n) finalize →
  O(Δ log n) diff → minimal wire patch. The live-query dream, made asymptotic.
- Caveats: a per-node pool-transaction constant (tunable fringe threshold if
  benchmarks demand); shapes are process-local (seeded hashes — nodes never
  cross the wire); iteration order becomes content-determined (an honesty
  *upgrade* over pool-history order).

### 8.3 Lists: dense radix vector, not RRB

RRB's O(log n) concat/slice comes from history-*dependent* relaxed nodes —
which breaks canonical shape and with it hash-consing, O(1) equality, and
pointer-pruned diffs. Dense radix vectors (Clojure `PersistentVector`) are
shape-canonical (a pure function of length, tail included). The operations RRB
accelerates are exactly the ones plain arrays are also bad at, so omitting them
violates no expectation. The contract table:

| op | plain `Array` | vector-backed `InternArray` |
| --- | --- | --- |
| `get(i)` | O(1) | O(log₃₂ n) — ≤ 7 hops |
| `set(i)` → new | O(n) | O(log₃₂ n) |
| `push`/`pop` → new | O(n) | ~O(1) amortized (tail) |
| iterate | O(n) | O(n) via **leaf-streaming iterator** (near-array locality) |
| `slice`/`concat`/mid-`splice` | O(n) | O(n) — *same as arrays, on purpose* |
| equality | O(n) | **O(1)** |

Exotic structures (ropes, RRB) are **userland value types** via
`createInternPool` + the symbols + a wire hint — first-class without being
shipped.

### 8.4 `toArray()` and the cache laws

- `toArray(): readonly T[]` — explicitly O(n), returns the **interned** flat
  array. Cross-representation unity: `list.toArray() === intern([...same])` —
  one canonical flat per list value, process-wide. A per-instance `WeakRef`
  memoizes the flatten; the *consumer* owns the lifetime by holding or
  dropping the result. Safe in render by construction (stable reference —
  Immutable.js's `toJS()` with the curse removed).
- The `.array` property is retired on vector backing: **properties are O(1);
  methods may cost.**
- **Per-instance caches on canonical values inherit canonical lifetimes** —
  interning makes values long-lived by design, so: O(1)-sized caches may be
  strong; **O(n)-sized caches must be evictable or must not exist** (the
  history-memory lesson: sticky flats would turn an undo history from
  O(n log n) into O(n²)). Iteration never materializes; only `toArray()` does.
- No `toMap()`/`toSet()`: native Map/Set are non-values; `new Map(m)` is the
  explicit mutable-copy escape.

### 8.5 No proxy facade — values may not lie about their kind

A perfect array-impersonating proxy (measured: `Array.isArray` true via the
array-target trick; 86 ns/element indexed vs 2 ns flat; 22 ns iteration with a
leaf-streaming iterator; `structuredClone` throws) was considered and
**rejected on identity grounds**: if the facade duck-types as an array, then
either equal-looking arrays are unequal (structural equality becomes dependent
on an invisible brand) or one value has two canonical objects (the pool's
founding invariant dies). The visible wrapper is the type distinction being
honest. Representation freedom lives instead **behind owned access paths**
(signals, the UI layer's tables, diff internals) — layers that own the door may
use any backing they like, because no raw value escapes.

---

## 9. The frontend story

### 9.1 Automatic deduplication is the product

Construction happens at *arrival rate* (network, user input — tens of events/s,
milliseconds of budget). Duplication costs are paid at **data × UI surface ×
frame rate**: one equal-but-not-`===` object defeats every memo, effect
dependency, selector, and reconciliation downstream, every frame, for as long
as it lives.

> Mutative optimizes the write path; valsem optimizes everything that happens
> after the write — and frontends read thousands of times per write.
> *Your app doesn't have a construction problem; it has an equality problem,
> and equality problems compound.*

Three distinct dividends: **identity dedup** (exact memo/effect skipping — the
framework's cheapest equality check becomes *correct*, framework-agnostically:
React memo, Solid/Vue signals, spindle signals all gate on reference equality),
**memory dedup** (one copy of equal data), **cache dedup** (values as `Map`
keys; hash-addressed caches).

Honest differentiation from immer/mutative: they already provide
*within-lineage* reference stability (path-copying preserves `===` for
untouched subtrees of one evolving tree). valsem's unique claims are
**lineage-free**: two independent fetches of the same rows are `===`; a
WebSocket message equals the cached value it duplicates; a recomputed selector
output equals last frame's. TanStack Query's `structuralSharing`
(`replaceEqualDeep`) is the ecosystem's hand-rolled, JSON-only, per-query
admission that this is needed; the React Compiler and the withdrawn
Records & Tuples proposal price the problem. The wire-to-memo demo: refetch
200 rows, 3 changed → exactly 3 components re-render, zero memoization code.

The honest boundary: never-repeating, write-dominated, never-compared data
(canvas ticks, unique sensor streams) pays hashing for nothing — use tier-2
commit boundaries, or don't use valsem for that state.

### 9.2 Benchmark posture

Measured on Mutative's own benchmark shape (50k×50-key objects + 1k map; one
append per op):

- naive reducer: 7,669 ops/s; post-hoc rebuild+intern: 424 ops/s — **~18×
  slower than naive** (≈40–100× vs mutative). Decomposition: 130 µs copy +
  ~2.2 ms hashing/pool. Engineering target with recorded ops + rolling-hash
  caches: **2–3× naive**. Still loses the update-throughput arena — by design.
- Delicious footnote: the benchmark's 50,000 array elements are structurally
  identical; interning collapses them to **1** object. The metric scores the
  defining feature zero while the dataset showcases it.
- Current flat `InternArray.push`: 2.5× naive (copy-bound, O(1) hash);
  vector-backed would top the chart by asymptotics — and must **never lead the
  marketing** (the Immutable.js trap: winning a plain-data benchmark with a
  class type convinces no one).

Positioning doctrine: category, not comparison ("canonical values"), complement
framing; **publish losses first** in BENCHMARKS.md (the 18× with its roadmap);
define the counter-arena (refetch-equality memo-hit-rate 0% vs 100%;
update→detect→patch pipeline; memory-under-history; opt-in large-collection
ops, clearly labeled).

---

## 10. Design laws (the short list)

1. **Companion invariant**: every equality ships a hash; `equal ⟹ same hash`.
2. **Only immutable things get value identity**; `Object.freeze` is not a
   proof of immutability.
3. **`undefined` is not a value in records; `null` is.**
4. **Order is never semantic.**
5. **Ergonomics is the contract; performance is the implementation.** Plain
   data by default; classes only where JS lacks the primitive; optimized types
   are opt-ins; optimizations are invisible.
6. **Values may not lie about their kind** (no structural liars; no proxy
   facades; visible wrappers are honest type distinctions).
7. **Properties are O(1); methods may cost.**
8. **O(1) caches may be strong; O(n) caches must be evictable** (canonical
   lifetimes are long by design).
9. **Pool membership is the universal marker** (finalize skip, draft scoping,
   node canonicalization).
10. **Finalize cost ∝ drafted spine + foreign material**; depth is free, width
    is the enemy.
11. **Fail loud at the boundary, never silently downstream** (rejection with
    teaching errors; `__proto__`-safe record building; strict draft
    revocation).
12. **Representation is public exactly where the platform can enforce
    immutability** (frozen arrays and strings yes; Map/Set backing no).

---

## 11. Roadmap

| Phase | Content | Gate |
| --- | --- | --- |
| 0 | Reserve `valsem` on npm; promote `valsem/internal` → `valsem/binding` (semver'd); repo split; docs site with the frontend-first pitch | names reserved; samme green against `valsem/binding` |
| 1 | **`produce`/`adopt`**: proxy drafts for plain data, draft classes for collections, semantic patch emission, per-call options; Mutative corpus as tests | all existing suites green; patch-emission property tests |
| 2 | Incremental finalize hashing (cached accumulators; polynomial append) — the 18×→2-3× work | Mutative-shape benchmark hits target |
| 3 | Adaptive HAMT backing for `InternMap`/`InternSet` (invisible) | conformance + property suites; benchmark wins on large collections |
| 4 | Hash-consed nodes: O(1) equality, Δ-proportional diff, transient finalize | equality/diff benchmarks; memory-floor demonstration |
| 5 | Vector-backed `InternArray`: leaf iteration, `toArray()` weak memo, retire `.array` | contract table holds empirically |
| 6 | Hardening backlog: lazy hash seeding; decode-boundary depth/size limits; property-based testing (fast-check) for the companion invariant and intern idempotence | — |

Non-goals, permanently: mutable built-ins as values; cycle support; wire
formats (samme's job); schemas (higher layers); framework adapters (the point
is needing none).

---

## 12. Decision log (abbreviated)

- **Removed Date/RegExp/Map/Set, then TypedArrays** — mutability, freeze
  ineffectiveness, and measured silent HashMap misses; teaching errors added.
- **`{ immutable: true }` gate for pooling** — hashable ≠ immutable (Date/RegExp
  counterexamples); Temporal pools unfrozen.
- **Record `undefined` normalization; InternMap keeps stored `undefined`** —
  accident vs TS-typed intent.
- **Encapsulated Map/Set backing; classes implement ReadonlyMap/ReadonlySet** —
  freeze is a no-op on internal slots; interop preserved by *being* the
  interface.
- **Symbols renamed to `valsem.*`** before first publish (cross-realm keys are
  forever).
- **NaN pool-split bug fixed** (`childEqual` = SameValueZero) — found by a
  cross-syntax wire property test.
- **`produce` unified with `intern`** — grafts force it; pool membership as the
  marker.
- **Draft classes over context-gated mutators** — interning-induced aliasing
  makes `this` location-ambiguous.
- **Dense radix vectors over RRB** — history-independence required for
  hash-consing.
- **`toArray()` over auto-materialization** — the n² history-memory argument;
  consumer-owned lifetime via the returned reference.
- **Proxy array facade rejected** — the structural-liar dichotomy (break
  `equal ⟹ ===` or break looks-equal ⟹ equal).
- **Positioning: dedup and lineage-free equality, not update throughput** —
  measured 18× loss on Mutative's arena, published honestly; the arena we
  define is the one the frontend actually runs.
