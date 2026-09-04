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

| Layer | Depends on |
| --- | --- |
| Value semantics (this project — `valsem`) | nothing |
| Wire format (schemaless, JSON + binary; developed separately) | valsem |
| Schemas, expression rules, IDL, UI | the above |
| Application runtimes | all of the above |

The dependency law is absolute and one-directional: **everything may depend on
valsem; valsem depends on nothing** — not on the wire format, not on any
framework, not on any runtime. A reactive UI layer dedupes via valsem's
`deepEqual`; a wire decoder interns via valsem's pool. Neither is visible from
inside valsem.

valsem is the TypeScript **binding** of a language-neutral information model
(the wire-format project above carries its specification). Other languages may
bind the same model without interning at all; interning is valsem's *strategy*
for delivering value semantics in JS, not part of the model.

### 1.2 Naming and packaging

- npm: **`valsem`** (unscoped — the vite/svelte pattern: the package people
  type stays unscoped). **Status: name verified free, NOT yet reserved.
  Reserve before anything else.**
- Repo split prerequisite — **done in this repo**: the pre-split
  `valsem/internal` subpath (consumed by the wire binding:
  `_defineRecordField`, `_mutableBuiltinReason`, `_hasValueSemantics`) is
  promoted to the small, semver'd **`valsem/binding`** API for first-party
  binding authors (underscore prefixes dropped: `defineRecordField`,
  `mutableBuiltinReason`, `hasValueSemantics`). An unstable cross-repo seam is
  a live wire; downstream bindings migrate when they start consuming the
  published package.

---

## 2. The information model: what is a value

### 2.1 The type inventory

| Kind | Host representation | Notes |
| --- | --- | --- |
| primitives | `null`, `boolean`, `number`, `string`, `bigint` | `NaN` equals `NaN`; `+0` equals `-0`; `undefined` is special (§2.3) |
| record | plain frozen object | **unordered** `key → value`; canonical form has sorted keys |
| list | plain frozen array | **ordered**; length is semantic |
| set | `ValueSet` (implements `ReadonlySet`) | unordered; members interned on entry (structural membership) |
| map | `ValueMap` (implements `ReadonlyMap`) | unordered; keys and values interned on entry (structural, value-keyed) |
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
| `Map` / `Set` | `ValueMap` / `ValueSet` |
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
- **`ValueMap` stores `undefined` deliberately**: `m.set(k, undefined)` is a
  real entry, distinct from absence (`has` distinguishes). With TypeScript, a
  `Map<K, V | undefined>` is declared intent in a way a record field never is.
  (`ValueMap.fromObject` takes a *record* as input, so record semantics apply
  to it: undefined-valued keys are not carried over.)

### 2.4 Iteration order is not part of the value

Order is observable on records, `ValueMap`, and `ValueSet`, but never
semantic: it does not affect equality, hashing, or which canonical instance you
get. Consequence: because equal collections collapse to a single canonical
instance, the order you observe carries no meaning. On `ValueMap`/`ValueSet`
it is **content-determined** (hash-consed HAMT backing, §8.2 — shipped): equal
collections iterate identically, in seeded-hash order — stable within a
process, different across runs, arbitrary by design. (Interned records are the
deterministic exception: canonical records have sorted keys.) If order carries
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
arrays order-dependently (polynomial); `ValueList` carries incremental hash
state (§3.4), while `ValueMap`/`ValueSet` hashes are their consed root-node
hashes (§8.2) — computed once per novel node, O(1) to read. Throws for anything without a hash handler — with teaching errors
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

Collections keep hashing off the read path:

- **Records/maps/sets**: a commutative accumulator (`acc' = acc − entry(old) +
  entry(new)`) is the scheme for record finalize-hashing under `produce`.
  `ValueMap`/`ValueSet` formerly kept such a `rollingSum`; since the consed
  HAMT swap their hash *is* the root node's consed hash — structural, cached
  per node, and shared with every equal subtree.
- **Arrays/lists**: for plain arrays (produce finalize-hashing), a polynomial
  accumulator with odd multiplier `P` (invertible mod 2³²):
  `h([a₀…aₙ]) = Σ hash(aᵢ)·Pⁱ`, composing over concatenation as
  `hash(A ++ B) = hash(A) + P^|A| · hash(B)`. `ValueList` formerly kept such
  an accumulator (`pPow`); since the vector rebuild its hash is derived from
  its consed root and tail nodes — structural, cached per node.

Planned: cache the raw accumulators on canonical instances so `produce`
finalization hashes in O(changes), not O(width) (§10.3).

---

## 4. Interning: the pool

### 4.1 Mechanics

A global pool of `hash → bucket record` (the singleton `WeakRef` is inlined in
the record; a true hash collision promotes it to an array) plus a
`WeakMap<object, hash>` cache. `intern(value)`:

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

On a miss: the hash is cached, plain data is **frozen**, and a `WeakRef` enters
the pool. The pool holds nothing alive: canonical instances are reclaimed when
unreferenced. **Interning does not leak.**

Pool *metadata* (records, dead refs) is reclaimed by a global **incremental
sweeper**: every pool's bucket records sit in one circular doubly-linked list,
and a cursor advances around it under a strict budget. The cleanup bill splits
three ways — **registrations pay a traffic tax** (a few slots of sweep credit
each, batched so the fixed cost lands once per ~16 ops), **GC epochs pay the
death tax** (ONE `FinalizationRegistry` sentinel — O(1) cells total, never per
entry — fires after each GC, the only event that can create dead refs, and
runs one bounded slice), and **lookups pay nothing**. An empty bucket unlinks
itself and deletes its map entry through a per-pool shared `WeakRef` to the
owning map, so a dropped pool's metadata unwinds wholesale as the cursor meets
it. The guarantee: *dead metadata anywhere is reclaimed within O(metadata /
budget) registrations or a few GC epochs, whichever comes first; nothing grows
without traffic, everything shrinks with any traffic; no monolithic sweep
pass, no per-entry finalizers, no timers.* Chosen over per-entry
`FinalizationRegistry` and over monolithic threshold sweeps **on measurement**
(`scripts/pool-gc-bench.mjs`): equal-or-better wall time, and both pause
pathologies — 15–54 ms in-batch threshold-sweep passes, 10–18 ms post-GC
finalization storms — flattened to baseline GC levels.

Canonical records are rebuilt with **sorted keys** and `__proto__`-safe field
definition (a `__proto__` key from `JSON.parse` becomes an ordinary own data
property — never a prototype swap).

### 4.2 `internHash` (and the deletion of `internEqual`)

`internHash` returns the cached hash in O(1) for canonical values, computing
structurally otherwise — pure, no side effects. `internEqual` was **deleted**:
it was a side-effecting equality predicate (its fallback interned both
arguments — freezing the caller's objects and pooling transients no equality
check can retain), its fast paths are exactly `deepEqual`'s canonical
short-circuit (which also resolved the old disagree-on-non-internables wart),
and callers wanting adoption semantics can say so explicitly:
`intern(a) === intern(b)`.

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
   (`ValueList`, `InternedString`).
4. **Optimizations are invisible.** Same syntax, same semantics; if a user can
   tell an optimization is on other than by timing it, it's a bug.

### 6.2 `ValueMap` / `ValueSet`

Persistent, immutable, canonical-instance collections on the hash-consed CHAMP
trie (§8.2): two with equal contents are the same reference — **lineage-free**,
since equal content converges on the same consed root however it was built —
carry the root's hash as their precomputed `[hashCode]`, compare in O(1)
(`[equals]` is a root pointer comparison), and update persistently
(`set`/`delete`/`add` path-copy O(log n) nodes and share the rest; an
unchanged write returns `this`).

- **They ARE the readonly interfaces**: `ValueMap implements ReadonlyMap`,
  `ValueSet implements ReadonlySet` (including the ES2025 set-algebra
  methods, which return fresh native `Set`s per the standard signatures). Pass
  them anywhere those are accepted; take a mutable copy with `new Map(m)`.
- **The backing store is a `#private` field, never exposed.** JavaScript cannot
  make a `Map`/`Set` immutable at runtime (`Object.freeze` is a no-op on their
  internal slots — verified: a "frozen" backing map could be mutated, corrupting
  the pool). Encapsulation removes the hole instead of guarding it — and is
  exactly what let the HAMT swap land invisibly. Instances themselves are
  frozen; the trie root and size are `#private`.
- **Keys, values, and members are interned on entry** — the invariant, not a
  convention: everything stored is a canonical value or primitive, so
  structurally equal raw inputs converge on one canonical collection, raw
  plain data is frozen at the door (closing the mutation-poisoning hazard —
  a mutable stored element could otherwise change under its cached hashes
  and split canonicality), and lookups canonicalize their probe so
  `get`/`has`/`delete` accept any structural equal. Internally slots compare
  by SameValueZero, which — on canonical contents — *is* structural
  equality. Stored `undefined` is legal in maps and distinct from absence
  (`trieGet` returns a sentinel, never `undefined`, for a miss); the wrapper
  canonicalizes through a `WeakMap<root, wrapper>` — ephemeron semantics, no
  scan, no sweep. (Class instances carrying their own `[equals]`/`[hashCode]`
  but no pool pass through `intern` unchanged — for those, identity
  semantics and mutation discipline rest with their author.)

The representation-visibility rule: **`InternedString.value` is public because
a primitive string is *genuinely* enforceable; the collections' backing trees
are private because nothing else is.** The representation is public exactly
where the platform can protect it. (`ValueList.array` was public under the
flat-array backing for the same reason; the vector rebuild retired it —
`toArray()` provides the frozen snapshot on demand.)

### 6.3 `ValueList` / `InternedString` — opt-in optimizations

`intern([1, 2])` already yields a canonical frozen `===`-comparable plain
array; strings natively have value semantics. What the wrappers add is purely
performance: `ValueList` is the hash-consed radix vector of §8.3 (O(log n)
persistent `push`/`pop`/`set` with structural sharing; equality is two
pointer comparisons on root and tail; `toArray()` snapshots on demand), and
`InternedString` precomputes a string's hash once. Accordingly they are
**opt-ins for measured hot paths, not defaults** — and on the wire they are
*hints* (`valsem.list`, `valsem.string`), not model types: a hint-blind
endpoint decodes them as the plain model value.

---

## 7. `produce` — the mutation story — **shipped**

> Built after a source-level study of immer and mutative (both ~3k lines;
> notes in the decision log). As-built deviations from the sketch below, all
> recorded there: collection drafts are overlays (base + edits/ops) rather
> than trie transients — the transient upgrade is Phase-2 perf work; DraftList
> materializes its working array on first write (the immer/mutative cost,
> accepted for v1); patches ship as a typed vocabulary (record.set/delete,
> list.set/splice, map.set/delete, set.add/delete, replace) with inverse
> patches and `applyPatches` implemented ON TOP of produce; the curried
> `produce(recipe)` form is included.

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

### 8.2 HAMT with hash-consed nodes — **shipped** for `ValueMap`/`ValueSet`

`ValueMap`/`ValueSet` are backed by a hash-consed CHAMP trie (`hamt.ts`,
stride 2 for maps, 1 for sets), swapped in **invisibly** behind the
encapsulated API (the payoff of §6.2's private fields). The deferred piece is
the adaptive flat small-map representation — low urgency, since a ≤32-entry
collection is already a single root node unless hashes share a 5-bit prefix.
CHAMP canonical form (non-root arity ≥ 2; deletes inline single-entry
subtrees upward, unwinding prefix chains; collision nodes keep a canonical
member order via type rank + per-instance ordinals) makes the shape a pure
function of content, which is what licenses the distinctive step: **intern
the trie nodes themselves** (the pool stops being a cache in front of the
data structure and becomes the data structure):

- HAMT shape is a function of the key-hash set — history-independent — so with
  node interning, equal maps are the same nodes to the root: **equality is
  O(1)** (the O(n) pool predicate ceases to exist).
- Normalization is per-edit, worst-case bounded: each edit pools O(log₃₂ n)
  nodes; with transients (= drafts), pooling happens once at finalize for the
  changed frontier only.
- **Memory hits the distinct-subtree floor**: maximal sharing process-wide,
  weakly held, GC'd. (Pedigree: hash-consing → ROBDD unique tables → Merkle
  DAGs; the incremental pool sweeper provides what BDD engines hand-roll.)
- **Diff becomes Δ-proportional**: pointer-pruned descent — a 100k-entry map
  with 3 changes diffs in ~3·log n. End-to-end: edit → O(Δ log n) finalize →
  O(Δ log n) diff → minimal wire patch. The live-query dream, made asymptotic.
- Caveats: a per-node pool-transaction constant (tunable fringe threshold if
  benchmarks demand); shapes are process-local (seeded hashes — nodes never
  cross the wire); iteration order becomes content-determined (an honesty
  *upgrade* over pool-history order).

### 8.3 Lists: dense radix vector, not RRB — **shipped**

RRB's O(log n) concat/slice comes from history-*dependent* relaxed nodes —
which breaks canonical shape and with it hash-consing, O(1) equality, and
pointer-pruned diffs. Dense radix vectors (Clojure `PersistentVector`) are
shape-canonical (a pure function of length, tail included). The operations RRB
accelerates are exactly the ones plain arrays are also bad at, so omitting them
violates no expectation. The contract table:

| op | plain `Array` | vector-backed `ValueList` |
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
  array, weakly memoized per instance; the *consumer* owns the lifetime by
  holding or dropping the result. Cross-representation unity holds:
  `list.toArray() === intern([...sameContents])` — one canonical flat per
  list value, process-wide — and `toArray()[i] === get(i)` always, because
  elements are already canonical (interned on entry). Safe in render by
  construction (Immutable.js's `toJS()` with the curse removed). (History:
  the first vector landing skipped the interning on an element-identity
  fidelity argument — valid only under the identity-membership semantics
  that intern-on-entry then replaced; see the decision log.)
- The `.array` property is retired on vector backing (**done**): **properties
  are O(1); methods may cost.**
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
React memo and Solid/Vue signals all gate on reference equality),
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

Measured against immer 11 and mutative 1.3 in-repo (`pnpm bench:produce`,
`scripts/produce-bench.mjs`; canonical 10k-scale bases, novel state per op;
libraries at shipped defaults). After the Phase-2 pass (incremental
accumulator hashing + prehashed interning, replay finalize, virtual DraftList,
frozen-aware copies):

| arena | valsem | immer (default) | mutative | standing |
| --- | --- | --- | --- | --- |
| 10k-entry map, one set | **3.5 µs** | 474 µs | 400 µs | **~120× ahead** (their drafts copy the container) |
| 10k-element list, set+push | **4.8 µs** | 9.6 µs | 9.0 µs | **~2× ahead** |
| 1000-key record, one set | **180 µs** | 208 µs | 208 µs | ahead; spread-copy floor is 153 µs |
| 10k plain array, one item edit | 28 µs | 575 µs / 3.0 µs (no freeze) | 3.4 µs | 8× behind the unfrozen libs — the measured floor decomposes as: drafting ~1 µs (virtual), successor copy ~7 µs (shadowed slice), and ~18 µs of **GC lifecycle for an 80 KB short-lived pooled value** (old-space promotion + major-GC collection + ephemeron cache entries) — invariant under ref strategy (eager WeakRef vs strong-nursery-then-weaken measured equal; the retention itself is the bill, not the ref). Their 3 µs array dies in the scavenger nursery untouched. `ValueList` is the designed answer: no 80 KB monolith per state |
| 3-key record churn | 1.3 µs | 0.8 µs | 0.6 µs | ~2× behind at the floor |
| recurrent states (10 held configurations) | **1.5 µs** | 531 µs | 3.3 µs | **fastest — and the only `===` results.** Transition memoization: a successor is a pure function of (canonical base, exact delta), so a repeat produce is O(touched) with no copy, no hash walk, no compare |

**The arena of record** (`scripts/big-array-bench.mjs`: results held in a
50-ring, one op per scheduling unit, one contender×mode per process):

| mode | valsem | immer (no freeze) | mutative |
| --- | --- | --- | --- |
| sync burst | 32 µs | 7.5 µs | 7.8 µs |
| microtask per op | 36 µs | 7.3 µs | 7.6 µs |
| **macrotask per op** (event-driven) | **18 µs** | 9.8 µs | 10.1 µs |

Findings: (1) with results held, the unfrozen libraries' realistic cost is
~8–10 µs, not 3; (2) valsem's event-driven cost is 18 µs — **a <2× gap** for
plain arrays; (3) V8 clears the kept-objects list only at MACROTASK
checkpoints — microtask-spaced produces retain like a sync burst, so many
produces inside one event turn should be batched into one recipe (or use
`ValueList`).

**The job-regime correction** (`scripts/yield-bench.mjs`,
`scripts/yield-bisect.mjs`): the spec's `AddToKeptObjects` retains every
`new WeakRef` target until the END OF THE CURRENT JOB — so a synchronous
bench loop of 2,000 produces force-retains all 2,000 80 KB results at once
(mass promotion, majors mid-loop), which is what the "~18 µs GC lifecycle"
mostly was. Under one-produce-per-task (the actual application regime),
every piece normalizes: WeakRef creation free, freeze free, cache entries
free, pool machinery ≈ +1.3 µs — full produce ≈ **13–19 µs vs their
~6 µs: a ~2–3× gap**, decomposed as ~6 µs copy (a cost class everyone
pays) + ~1.5 µs pool + ~5 µs draft machinery. The 27 µs sync number
remains true for batch loops — whose answer is batching edits into one
recipe, or `ValueList`. No code fix exists for in-job WeakRef retention;
it is spec semantics, now documented.

**Retention-pattern audit** (`scripts/retention-bench.mjs`, one scenario per
process — heap cross-pollution otherwise corrupts every number): the
discarded-result arena flatters the unfrozen libraries, whose results die in
the scavenger nursery. Under realistic patterns — results held by
subscribers/history, or the reducer chain `current = produce(current, …)` —
their cost rises 1.5–2× (mutative 3.4 → 5–7 µs, immer 3 → 6–12 µs) while
valsem's ~27 µs is retention-invariant (its bill was never the caller's
retention; it is the pooling infrastructure per novel big flat array). Net:
plain-array stays ~4–5× behind under real usage — and the reducer chain over
`{ list: ValueList }`, the designed shape, runs at **5.5 µs — inside their
band, with canonical `===` results**. Under realistic retention the
migration story closes the gap entirely.

The historical 18×→2–3× target is met and beaten where the design says hot
data belongs (the collections); flat plain arrays keep an honest 8× novelty
tax that buys `===` equality, O(1) hashing, and process-wide dedup.
Engineering note earned by measurement: **V8's `Array.prototype.slice` fast
path excludes frozen-elements arrays (65× slower); spread is 9 µs** — every
copy of a possibly-canonical array must be frozen-aware (`copyArr`).
- Delicious footnote: the benchmark's 50,000 array elements are structurally
  identical; interning collapses them to **1** object. The metric scores the
  defining feature zero while the dataset showcases it.
- Current flat `ValueList.push`: 2.5× naive (copy-bound, O(1) hash);
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
| 0 | Reserve `valsem` on npm; ~~promote `valsem/internal` → `valsem/binding` (semver'd)~~ done; ~~repo split~~ done (this repository); docs site with the frontend-first pitch | name reserved; the wire binding green against `valsem/binding` |
| 1 | ~~**`produce`/`adopt`**: proxy drafts for plain data, draft classes for collections, semantic patch emission~~ done (collection-draft transients and a Mutative-derived test corpus remain) | all existing suites green; patch-emission property tests |
| 2 | ~~Incremental finalize hashing (cached accumulators; polynomial append) — the 18×→2-3× work~~ done (records + stable-position arrays; §9.2 table). Remaining perf backlog: mid-splice array deltas, trie transients for bulk collection drafts, withPatches overhead, small-state floor | Mutative-shape benchmark hits target ✓ |
| 3 | ~~HAMT backing for `ValueMap`/`ValueSet` (invisible)~~ done (adaptive flat small form deferred) | conformance + property suites; benchmark wins on large collections |
| 4 | ~~Hash-consed nodes: O(1) equality~~ done for map/set; Δ-proportional diff and transient finalize arrive with `produce` | equality/diff benchmarks; memory-floor demonstration |
| 5 | ~~Vector-backed `ValueList`: leaf iteration, `toArray()` weak memo, retire `.array`~~ done | contract table holds empirically |
| 6 | Hardening backlog: lazy hash seeding; decode-boundary depth/size limits; property-based testing (fast-check) for the companion invariant and intern idempotence | — |

Non-goals, permanently: mutable built-ins as values; cycle support; wire
formats (a separate layer's job); schemas (higher layers); framework adapters
(the point is needing none).

---

## 12. Decision log (abbreviated)

- **Removed Date/RegExp/Map/Set, then TypedArrays** — mutability, freeze
  ineffectiveness, and measured silent HashMap misses; teaching errors added.
- **`{ immutable: true }` gate for pooling** — hashable ≠ immutable (Date/RegExp
  counterexamples); Temporal pools unfrozen.
- **Record `undefined` normalization; ValueMap keeps stored `undefined`** —
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
- **Replaced per-entry `FinalizationRegistry` and threshold sweeps with the
  global incremental circle sweeper + O(1) GC-epoch sentinel** — decided on
  measurement, not argument (`scripts/pool-gc-bench.mjs`): per-entry FR was
  *not* slower on throughput (refuting the initial argument) but storms
  10–18 ms in post-GC tasks; threshold sweeps pause 15–54 ms in-batch; the
  circle+backstop matched or beat both on wall time with both pause shapes at
  baseline. Two measured traps now baked into the design: deref the owner
  only on the removal path (owner-deref per visit cost 2.4×), and hold the
  backstop registry from a module binding (an unreferenced
  `FinalizationRegistry` is collected and its callbacks silently stop).
- **Shipped the hash-consed CHAMP backing for `ValueMap`/`ValueSet`** —
  equality became a root pointer comparison and canonicality became
  lineage-free at the node level; the collection hash became the consed root
  hash (replacing the rolling sums); iteration order upgraded from
  pooled-first to content-determined; wrappers canonicalize via
  `WeakMap<root, wrapper>` ephemerons. Canonical form pinned by fuzz suites
  (shuffled builds, op-walk mirrors, per-run seed variation) plus a
  total-collision suite under a degenerate `configureHasher` — which also
  fixed a latent NaN-value pool split (predicates used `!==`; the trie uses
  SameValueZero throughout). Deferred: the adaptive flat small-map form (a
  ≤32-entry collection is already one root node); node-level set algebra.
- **Should deepEqual throw on incomparable input? No — settled** — asked
  directly and answered on three grounds. Principled: for mutable objects
  reference equality IS the correct equality (substitutability — two Dates
  with equal time are not substitutable; one setTime later they diverge;
  content comparison over independently-mutable objects asserts a sameness
  mutability falsifies), and identity comparison of unregistered class
  instances in state records is a feature, not a fallback. Structural:
  throwing belongs at the boundaries that ADMIT data into value-land
  (deepHash/intern/collections/produce — all throw, with teaching text);
  deepEqual is a passive query, not an admission point. Practical: equality
  predicates sit in memo comparators and dedup gates that must not throw on
  stray foreign data; every peer is total for the same reason. README
  reframed from "cannot throw" to the substitutability argument.
- **deepEqual benchmarked against fast-deep-equal; record branch
  restructured** (`pnpm bench:equal`) — verdict-agreement asserted per pair
  (corpus avoids the two semantic divergences: NaN and undefined-valued
  keys, where valsem answers true and fast-deep-equal false). Results: raw
  arrays ≥100 elements 2.5–2.9× faster; raw records at parity on equal
  walks (was 1.6–1.8× behind — the undefined-dropping semantics was paying
  for…in + double hasOwnProperty + an unconditional second pass; now
  Object.keys iteration, one hasOwn on the b side as the
  prototype-pollution guard, deferred b-key snapshot, and a single-pass
  common case) and 1.6–1.8× faster on unequal records; tiny records ~1.2×
  behind (Object.keys allocation floor, ~300 ns absolute); canonical pairs
  20–33 ns flat regardless of size — 9× to 1200× — and mixed-boundary
  inequality 5.6×. The semantics cost of undefined-dropping is now one
  deferred Object.keys, only on successful matches.
- **`[interned]` clarified as a TYPE contract; deepEqual's marker check
  strengthened (supersedes the marked-vs-unmarked test of the previous
  entry)** — the original intent, restated by the author: `[interned]`
  marks *auto-interning types* — no publicly reachable constructor, every
  instance canonical by construction (the collections and the
  `createInternPool` pattern with its private constructor). Under that
  contract, a non-identical pair with EITHER side marked is unequal: same
  type would imply both marked, so a mixed pair is cross-kind. deepEqual
  now concludes on `aMarked || bMarked` — one or two property reads, no
  map lookups, and mixed marked/raw pairs skip the dispatch entirely. The
  earlier "fresh unmarked instance equals its marked canonical" behavior
  is reclassified as a contract violation (a type exposing non-interning
  construction must not carry the marker) and the regression test inverted
  to pin the contract instead.
- **internEqual deleted; [hashCode] pre-filter added to deepEqual** — the
  audit of the new fast path surfaced that `internEqual` was a
  side-effecting predicate: its fallback interned both arguments, FREEZING
  the caller's objects and pooling transients an equality check cannot
  retain (unheld canonicals die; the pool churns). Its legitimate fast
  paths were exactly what canonical-aware `deepEqual` now does without side
  effects, so it went; `intern(a) === intern(b)` states adoption
  explicitly. The audit also added the one genuinely missing hash use:
  distinct precomputed `[hashCode]`s on class instances prove inequality
  (companion invariant) before running a potentially O(n) `[equals]`.
- **deepEqual consults canonicality** — after the primitive checks, if both
  sides are canonical (the `[interned]` marker, or membership in the
  interner's hash cache, injected into the leaf module the same way
  deepHash's cache is), a `!==` pair is structurally distinct by the
  canonicality invariant: O(1) false, no walk. Measured: distinct canonical
  1000-key records 74 µs → 0.04 µs (~1800×); mixed raw trees terminate at
  every canonical boundary; worst-case raw-vs-raw walk overhead +1.3%.
  Trust note: the `[interned]` marker and `{ immutable: true }` were always
  contracts — stamping them on non-canonical data has always broken
  equality, and now does so faster.
- **Freeze-disable experiment: measured, not shipped (negative result
  three of the phase)** — a temporary `_setFreezing(false)` switch was A/B'd
  across every arena. Event-driven big-array: zero. Collections, recurrent,
  small-churn: zero. Sync-burst big-array: −9–15%. The one genuine,
  regime-independent cost found: `Object.freeze` on records is ~38 ns per
  property (−21% on the 1000-key arena — where `ValueMap` is 30× faster
  than either freeze setting anyway). Conclusion: the phase-2 optimizations
  (shadow copies, transition memoization, virtual drafts) removed every
  path where frozenness was expensive — freezing is now effectively free
  where the library's shapes and regimes live, so no escape hatch ships and
  the safety invariant stands without a performance caveat. The switch was
  reverted; the produce bench gained the honest big-array scenario
  (held results, one produce per macrotask) as a permanent in-suite arena.
- **The AddToKeptObjects correction (amending the entry below)** — pressed
  on whether 26 µs could be real ("do we re-hash the entire array?" — no:
  hashing is O(1) delta), the bisection was redone under a
  one-produce-per-task regime, and the previous "memory-system physics"
  attribution partly dissolved: `new WeakRef(target)` performs
  AddToKeptObjects, retaining the target until the current JOB ends, so a
  synchronous bench loop force-retains every result at once — that was the
  "promotion pathology", and why the StrongCell nursery measured identical
  (strong retention ≡ kept-objects retention in-job). Event-driven
  decomposition: copy ~6 µs + pool ~1.5 µs + draft machinery ~5 µs ≈ 13–19
  vs their ~6 — a 2–3× plain-array gap in real regimes, not 8×. Three
  benchmark-methodology lessons now on file: discarded results flatter
  unfrozen libraries; in-process scenario order corrupts numbers; and
  synchronous produce loops trip AddToKeptObjects.
- **Retention-pattern audit** — prompted by the observation that real
  applications HOLD the state they produce: benched discarded vs held vs
  reducer-chain vs chain-with-history, each in a fresh process (in-process
  section order corrupted results by whole multiples — a benchmark lesson
  worth the entry alone). Findings: the discarded arena flatters the
  unfrozen libraries ~1.5–2×; valsem's plain-array cost is
  retention-invariant; the gap under realistic patterns is ~4–5×, closed
  entirely by the ValueList chain at 5.5 µs. Also fixed en route: the
  shadow-copy cache built a shadow on FIRST copy, double-copying one-shot
  bases (reducer chains) — now engages only on the second copy of the same
  base (chain scenario 47.8 → 25.9 µs).
- **Big-array floor investigated; nursery-deferred WeakRefs tried and
  REVERTED (negative result, recorded)** — isolates showed
  `new WeakRef(freshBigArray)` costs ~24 µs (vs 0.04 µs on an old object,
  ~0 for fresh small objects, ~0 for WeakMap keys) — apparently forced
  early promotion. A strong-nursery that deferred WeakRef creation to the
  GC-epoch backstop was built — and measured **exactly nothing**: the bill
  is the retention lifecycle itself (any pooled 80 KB short-lived value gets
  promoted, collected by major GC, and drags ephemeron cache entries),
  identical whichever ref holds it. Reverted per the measured-optimizations
  law. What stayed: the unfrozen shadow cache for large frozen bases
  (repeat copies at slice speed, WeakMap-keyed per the §8.4 cache law).
  The durable finding: valsem's plain-array novelty tax at 10k scale is
  ~18 µs of memory-system physics for materializing a *findable* 80 KB
  state; the fix is structural (ValueList), not micro.
- **Transition memoization + virtual array drafts (Phase-2, second pass)** —
  the recurrent arena was 17× behind mutative (48 µs vs 2.9) because
  recognizing a recurring successor cost O(n): a draft-time copy of the 10k
  base plus a frozen-read-taxed structural compare on the pool hit. Two
  changes: plain-array drafts gained DraftList's virtual mode (point edits +
  appended tail; push/pop/index ops never copy; iteration and read-only
  methods work virtually via prototype dispatch through the traps; only
  ownKeys/mid-splices/sort materialize), and finalize now memoizes
  **transitions** — `WeakMap<canonical base, recent {delta, WeakRef
  successor}>` — sound because a successor is a pure function of (base
  identity, exact delta), so a repeat produce verifies O(touched) with no
  hash trust and builds nothing. Result: recurrent 48 µs → **1.5 µs — the
  fastest in the arena, 2× ahead of mutative — returning `===` pooled
  instances**. Two instructive misses en route: the bench originally
  discarded its results, so the weakly-pooled states died under GC and every
  lookup missed (real recurrence means the states are held — the bench now
  holds them); and a transition cap of 8 thrashed against the 10-state cycle
  (now 16).
- **Phase-2 performance pass, measure-first** — built the in-repo bench
  against immer/mutative before touching code. Changes: array deepHash moved
  to a positional polynomial accumulator (the chained mix could not be
  delta-updated); canonicalization now caches raw accumulators
  (`accCache`), and produce's finalize delta-updates them —
  `_internPrehashed` skips rehash and child walks for records with no added
  keys and sequences whose ops keep positions stable (sets + tail splices);
  DraftList gained a virtual mode (point edits + appended tail over the
  base, no materialization) with persistent-replay finalize; child-drafting
  restricted everywhere to base-positioned values (the immer rule), which
  also fixed a patch/result divergence for drafted-after-insert material.
  The find of the pass: **V8's `slice` fast path excludes frozen-elements
  arrays** — 229 µs vs 3.5 µs at 10k — discovered only because the profiler
  lied and a bisection script didn't. Every copy of possibly-canonical
  arrays is now frozen-aware. Results in §9.2's table: three arenas ahead
  of both libraries, the plain-array arena at an honest 8× novelty tax.
- **Shipped `produce` after a source-level study of immer and mutative** —
  the study (repos read in full) found both share one skeleton: lazy
  copy-on-write proxy drafts, assignment maps, net patches; immer's costs are
  default deep-freezing and callback-heavy finalize (reverse maps for
  aliased drafts); mutative's speed comes from opt-in freezing and a flat
  LIFO finalize stack; both copy whole Map/Set containers on first write and
  neither recovers array splice intent (index-wise patches, confirmed in
  source). Our resolution: **finalize is an intern walk** — both libraries
  work to avoid a walk that interning must do anyway, so draft replacement,
  graft adoption, and patch emission ride it; aliased drafts converge by
  memoization because the walk interns. Canonicality detection is the pool
  marker, not `isFrozen` (which would wrongly prune frozen-but-foreign
  data). DraftList records splices as intent (method API — no proxy
  ambiguity); plain arrays intercept mutating methods for the same, falling
  back to net index-diff on sort/reverse/fill/length. Inverse-patch law:
  forward values resolve drafts to their final canonical, restore values
  resolve drafts to their base. v1 costs accepted and earmarked: overlay
  collection drafts (not yet trie transients), DraftList materializes on
  first write, changed nodes rehash from scratch (assignment maps retained
  so incremental hashing can drop in).
- **Shipped the hash-consed dense radix vector for `ValueList`** — trunk of
  full 32-wide consed leaves + consed tail (the tail is itself a leaf node,
  so wrapper equality is two pointer comparisons); trunk/tail split and tree
  height are pure functions of length, so push-building, `from()`, and
  set/pop detours converge instance-exactly (pinned across the 32/1024
  boundaries and height collapse). `.array` retired in favor of `get(i)`,
  index-order iteration, and `toArray()`. (The first landing skipped
  interning the snapshot on an identity-fidelity argument — superseded one
  step later by intern-on-entry, below.)
- **Keys, values, and members intern on entry (identity → structural
  membership)** — prompted by the observation that under identity
  membership the collections could not keep their own canonicality promise:
  a mutable raw element could be mutated after insert, changing its hash
  under the cached node hashes and splitting equal content into distinct
  "canonical" instances (`ValueList.of(o) !== ValueList.of(o)` after
  `o.a = 2`) — the same silent-wrong-answer genus that expelled Date and
  native Map/Set. Interning at the door makes canonical-all-the-way-down an
  invariant: raw structural equals converge, stored plain data is frozen,
  probes canonicalize, and `toArray()` is the interned flat with
  `toArray()[i] === get(i)` — restoring the original §8.4 sketch, whose
  fidelity objection only held under the replaced semantics.
- **Renamed `Intern{Map,Set,Array}` → `ValueMap`/`ValueSet`/`ValueList`** —
  type names name model kinds; mechanism vocabulary (interning) belongs to
  operations (`intern`, pools, the `interned` symbol). "List", not "Array":
  names may not lie about their kind — the class has no subscript access, and
  "list" is the model kind. The string wrapper keeps a mechanism name: its
  value is the wrapped *string* (not a distinct kind), so a `Value*` name
  would overclaim — the class *is* the mechanism (cached hash, pooled
  identity), and its name honestly says so. (Initially kept verbatim as
  `InternString`; renamed `InternedString` shortly after — the adjective is
  the grammatical form, "an interned string".) `HashMap` stays: a mutable
  lookup structure named by mechanism is the established convention.
