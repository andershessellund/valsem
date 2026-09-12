# valsem — Design

**Value semantics for JavaScript.** Structural equality, companion hashing,
global interning, canonical instances, and immutable value collections, so
that `===` *is* deep equality, equal data exists once in memory, and change
detection is a pointer comparison.

This document describes the library as it is: the model, the invariants,
and how each mechanism works, in enough detail to work on the code or to
reimplement it. It says *what*; the *why*, the alternatives and the
measurements are in [DECISIONS.md](DECISIONS.md), cited as `D<n>`. Current
numbers are in [BENCHMARKS.md](BENCHMARKS.md). User documentation is the
README and the guide under `docs/`.

---

## 1. What valsem is

Reduced to one sentence:

> **valsem is one operation, `(value, recipe) → canonical value`, where
> equality is `===`, cost is proportional to novelty, and everything else is
> sugar.**

```ts
const a = intern({ city: 'Aarhus', zip: '8000' });
const b = intern({ zip: '8000', city: 'Aarhus' });
a === b;                       // true — one frozen canonical instance

deepEqual({ x: 1 }, { x: 1 }); // true — structural
deepHash(a);                   // O(1) — cached on the canonical instance
```

Three properties arrive together and reinforce each other:

1. **Value equality is `===`.** No traversal per comparison.
2. **Hashing is O(1)** after canonicalisation (cached).
3. **Sharing is automatic.** Equal subtrees are stored once, process-wide.

### 1.1 Position in the stack

valsem depends on nothing: not on a wire format, a framework, or a runtime.
Everything may depend on it. A reactive UI layer dedupes via `deepEqual`; a
wire decoder interns via the pool; neither is visible from inside valsem.
valsem is the TypeScript binding of a language-neutral information model;
interning is its *strategy* for delivering value semantics in JavaScript,
not part of the model.

### 1.2 Entry points

| Subpath | Contents |
| --- | --- |
| `valsem` | the API: equality, hashing, interning, the collections, `produce`, `memoize`, the switches |
| `valsem/temporal` | side-effect import registering value semantics for the eight Temporal kinds (§5.3) |
| `valsem/draft` | the toolkit for making a type draftable (§7.1); semver-covered |
| `valsem/binding` | the two helpers a wire or storage binding needs (§10.1); semver-covered |

Ships as ES modules with declarations, dependency-free. Requires `WeakRef`,
`FinalizationRegistry` and `globalThis.crypto`; uses the global `Iterator`
as an iterator base class where the runtime has it. Declared floor: Node ≥
22, current browsers, workers, Deno, Bun. `sideEffects` lists only the
Temporal entry (D7).

---

## 2. The information model: what is a value

### 2.1 The type inventory

| Kind | Host representation | Notes |
| --- | --- | --- |
| primitives | `null`, `boolean`, `number`, `string`, `bigint`, `symbol` | `NaN` equals `NaN`; `+0` equals `-0`, and canonical state holds `+0` only (D22); `undefined` is special (§2.3); functions are not values |
| record | plain frozen object | **unordered** `key → value` over own enumerable string and symbol keys |
| list | plain frozen array | **ordered**; length is semantic; holes canonicalise to `undefined` |
| set | `ValueSet` | unordered; members interned on entry |
| map | `ValueMap` | unordered; keys and values interned on entry; stored `undefined` is a real entry |
| ordered set / map | `OrderedSet` / `OrderedMap` | **ordered** member / entry sequence; order is part of the value |
| optimised list | `ValueList` | a distinct type whose value is its element sequence (§6.4); not equal to the plain array of the same elements |
| timestamp | `ValueDate` | epoch milliseconds; the value a `Date` stands for |
| interned string | `InternedString` | the wrapped string, with its hash paid once |
| raw view | `RawArray` | a value by identity, not by content (§6.7) |
| Temporal | `Temporal.*` via `valsem/temporal` | eight kinds |
| your value types | classes via symbols or registration | §5 |

### 2.2 Mutable values are not values

`Date`, `RegExp`, native `Map`/`Set`, and the entire TypedArray family
(`DataView`, `ArrayBuffer`, `SharedArrayBuffer` included) are rejected:
`deepHash`, `intern`, the collections, `produce` and `memoize` throw, each
error naming the immutable replacement. `deepEqual` alone never throws on a
type and reports reference semantics (§3.1). A subclass of a rejected type
is rejected with it (the check walks the constructor chain). The rejection
table lives in one place (`deep-equal.ts`, `_mutableBuiltinReason`) and is
shared by every throwing surface and by `valsem/binding`, so one type gives
one explanation wherever a user meets it. Why: D1, D24.

| Instead of | Use |
| --- | --- |
| `Date` | `ValueDate.of(d)`, or `Temporal.Instant` with `valsem/temporal` |
| `RegExp` | a plain `{ source, flags }` record |
| `Map` / `Set` | `ValueMap` / `ValueSet` (or the ordered twins) |
| TypedArrays / buffers | hex or base64 strings |

### 2.3 `undefined` is not a value (in records)

A record is a partial function from keys to values; a key mapped to
`undefined` is the same record as one without the key:

```ts
deepEqual({ a: undefined }, {});           // true
intern({ a: undefined }) === intern({});   // true — the canonical form drops the key
```

Arrays are positional, so `[undefined]` has length 1 and differs from `[]`.
`ValueMap` stores `undefined` deliberately: `m.set(k, undefined)` is a real
entry distinct from absence (`has` distinguishes; the trie returns a
sentinel, never `undefined`, for a miss). `ValueMap.fromObject` takes a
*record*, so record semantics apply to its input. Why: D25.

### 2.4 Order is semantic exactly where the type says so

Order is part of the value for arrays, `ValueList`, `OrderedMap` and
`OrderedSet`, and never for records, `ValueMap` and `ValueSet`. On the
unordered kinds order is still *observable*, and it is never meaningful:

- `ValueMap`/`ValueSet` iterate in a content-determined order (the trie's
  structure, driven by seeded key hashes): equal collections iterate
  identically, stable within a process, different across runs.
- A canonical record's key layout is that of the first spelling interned
  in this process (string keys, then symbol keys). Equal records are one
  object, so this too is stable within a process and meaningless (D10).

If order carries meaning, put it in the value: an array or `ValueList`, or
an ordered collection.

### 2.5 Equality is substitutability, up to canonicalisation

`deepEqual(a, b)` means a and b are interchangeable everywhere *after
canonicalisation*. Observable-but-nonsemantic aspects (key order,
`ValueMap` iteration order, present-`undefined`, the sign of zero) are
erased by the canonical form. This is what makes interning sound: the pool
may substitute either object for the other.

### 2.6 Symbols

A registered symbol (`Symbol.for(name)`) *is* its name: hashed by the name,
so it agrees across realms and installs. A unique symbol (`Symbol(desc)`,
the well-known symbols) is an identity with no content: it hashes by an id
assigned on first sight and kept in the hash cache (unique symbols are
valid `WeakMap` keys since ES2023; registered ones are not, which is why
they take the other branch). Symbols work as record fields, record keys,
`HashMap` keys and collection members. Own enumerable symbol keys are part
of a record's content. valsem's protocol symbols (`equals`, `hashCode`,
`interned`, `toDraft`) are honoured on class instances only; on a plain
record they are ordinary keys, so a record cannot forge canonicality or
choose its own hash. A draft rejects writing them. Why: D9, D27.

---

## 3. Equality and hashing

### 3.1 `deepEqual`

Dispatch, in order:

1. `a === b` → true. Then non-objects: true only for `NaN`/`NaN`.
2. **Canonical fast path.** If either side carries `[interned] === true`
   (a class instance; on a plain record the symbol is a key) the pair is
   unequal. If both sides are in the interner's hash cache the pair is
   unequal. Two distinct canonicals are distinct values (D27).
3. `Array.isArray` on either side: both arrays, element-wise, or false.
4. `[equals]` read from `a`'s **prototype** (an own instance property is
   not protocol): same constructor required (a subclass is its own type);
   then, if both sides carry a numeric `[hashCode]` and they differ, false
   without calling `[equals]` (the companion invariant); else the method's
   verdict. If only `b` declares `[equals]`, false (the answer must not
   depend on argument order).
5. Registry: same constructor on both sides and a registered handler.
6. Plain records (prototype `Object.prototype` or `null`): own enumerable
   string and symbol keys, `undefined`-valued keys skipped, `hasOwn` on the
   other side (never `in`), single pass in the common case with a deferred
   key count only when undefined-valued keys exist.
7. Anything else → false. Two distinct instances of the same mutable
   built-in additionally log a once-per-type development warning (D24).

`deepEqual` is total: it never throws on a type. It is uncapped; on raw
cyclic input it recurses until the engine throws (§9).

### 3.2 `deepHash` — the companion invariant

> `deepEqual(a, b)` ⟹ `deepHash(a) === deepHash(b)`, always. The converse
> never holds. Every equality in the system has a companion hash, and every
> new equality must ship one.

Dispatch mirrors `deepEqual`: primitives; arrays; the mutable built-ins
(throw); `[hashCode]` as property, getter or method; the registry; plain
records; any other class (throw, naming what it lacks). Type tags are
mixed into every hash so arrays, records and sets with similar content
differ. Records hash **order-independently** and arrays **positionally**
through accumulators (§3.4). Canonical objects return their cached hash in
O(1). `deepHash` is depth-capped (§9).

### 3.3 Leaf hashing

Every string and number leaf goes through the active `Hasher`; the
structural combiners (`mix`, the accumulators) are fixed. The default is
**Marvin32** over UTF-16 code-unit pairs for strings and a seeded avalanche
over the IEEE-754 bits for numbers (`-0` normalised to `+0`), keyed by the
first two words of a 128-bit seed drawn once per process from
`crypto.getRandomValues` and stored on `globalThis` under
`Symbol.for('valsem.hashSeed.v1')` so duplicate installs agree. `configureHasher(hasher)` replaces both
primitives once, before any leaf has been hashed, and throws afterwards;
`getHashSeed()` exposes the seed for a keyed PRF such as SipHash.
`createMarvin32Hasher(k0, k1)` builds the default with a chosen key. Hashes
are process-local and never cross the wire. Why: D28.

### 3.4 Canonical meta and the incremental accumulators

Every canonical object has one entry in a single `WeakMap`: `{ h, a, n }`,
its hash, its raw accumulator, and its defined-entry count (`n` is −1 for
pooled value-type instances, which have no accumulator). The meta never
refers back to its key (D11). The same map holds unique symbols' identity
hashes.

The accumulators are sums modulo 2³² of independent per-entry terms:

```
record: acc = Σ scramble(mix(hash(key), hash(value)))      commutative
array:  acc = Σ hash(element_i) · P^i                      positional, P odd
hash    = mix(mix(TAG, count), acc)
```

`P` is odd, hence invertible, so an entry can be removed as well as added.
`produce`'s finalize delta-updates a canonical base's accumulator in
O(changes) and interns the successor prehashed (§7.4). The helpers
(`_entryTerm`, `_recordHashOf`, `_arrayHashOf`, `_powP`) are the single
source for the from-scratch and the incremental paths.

The collections do not use accumulators: a `ValueMap`/`ValueSet` hash is
its consed root's hash, a `ValueList` hash is derived from its consed root
and tail, computed once per novel node.

---

## 4. Interning

### 4.1 `intern`

`intern(value)` returns the canonical instance of a value:

- A primitive returns as-is, except `-0` → `+0`.
- An object marked `[interned]` (a class instance) or present in the hash
  cache returns immediately.
- An **array** is interned bottom-up: each own slot interned (a hole reads
  as `undefined`, never through to `Array.prototype`), then the array is
  hashed with its accumulator, looked up by shallow SameValueZero on the
  interned children, and on a miss given meta, frozen, and registered.
- A **record** is interned bottom-up, and the hash is folded from the
  `(key, interned child)` pairs *without building the copy*; the pool
  candidate is matched by key against the interned children (any layout).
  Only on a miss is the canonical copy built: keys in the incoming order,
  `undefined`-valued keys dropped, `__proto__` defined as an own data
  property; by assignment up to 16 keys (sharing the raw object's hidden
  class when the order matches), `Object.fromEntries` above that (D8,
  D12). Then meta, freeze, register.
- A **class instance** is checked against the mutable-built-in table first
  (throw, naming the replacement). A **value type**, one with an equality
  and a hash by symbol or by registration, is pooled by its own equality
  and the constructor as the type, **unfrozen**. Anything less throws,
  naming what is missing; nothing passes through.

`intern` is depth-capped (§9). `createInterner()` is a deprecated wrapper
returning `{ intern }`.

### 4.2 The pool

One `InternPool` per kind of thing: the global pool for plain data and
value-type instances; two per trie configuration (bitmap and collision
nodes; `ValueSet`, `ValueMap`, `OrderedSet` and `OrderedMap` each have
their own configuration); `ValueList`'s node pool and its list pool; one
each for `OrderedMap`, `OrderedSet`, `InternedString` and `ValueDate`; and
any number created by `createInternPool`. (`ValueMap` and `ValueSet`
wrappers need no pool: they canonicalise through a `WeakMap` keyed by root,
§6.3.) A pool
is a `Map` from a 30-bit key (`hash & 0x3fffffff`, so it is always a Smi)
to a bucket: one `Slot`, or an array of slots when two keys collide. A
`Slot` *is* the `WeakRef` to the pooled object (a subclass), carrying the
full 32-bit hash and its pool; `lookup(hash, predicate)` pre-checks
`slot.hash` before dereferencing. `register(value, hash)` prunes dead
members of the bucket in passing. Why: D3.

Cleanup: one global `FinalizationRegistry` reports each death after the
major GC that clears its `WeakRef`. The callback pushes the slot on a
LIFO stack and schedules a drain: `requestIdleCallback` where it exists
(deadline-bounded slices, at least 64 per call), else `setImmediate`
(4096 per turn), else inline. The stack is bounded at 100k; beyond it,
deaths are reclaimed inline. The registry is held from a module binding.
The pool holds nothing alive; a dropped pool is retained only as long as
its last live member. Why: D2.

`pool.intern(object)` is the high-level entry: returns `object` if marked,
otherwise looks up by its `[hashCode]` and `[equals]`, and on a miss marks
it `[interned]`, freezes it, and registers it.

### 4.3 Probes

- `isCanonical(v)`: a primitive (not a function), or an object in the hash
  cache, or a class instance marked `[interned]`. The probe behind every
  canonical short-circuit.
- `fastEquals(a, b)`: `a === b`, after verifying both sides canonical while
  checks are on (a raw argument throws rather than yielding a silent
  `false`).
- `internHash(v)`: the cached hash in O(1) for canonical objects, `deepHash`
  otherwise. Pure.

### 4.4 Freezing and the two switches

Plain records and arrays are frozen when they become canonical; valsem's
own classes (the collections, `ValueDate`, `InternedString`, `RawArray`)
freeze their instances unconditionally; user value-type instances pooled
through `intern` are not frozen. Two one-way,
process-wide switches, read live and independent of the environment:
`skipChecks()` stops the *canonical only* verification in `fastEquals`;
`skipFreezing()` stops freezing canonical records and arrays. Drafts
copy-on-write through a canonical whether or not it is frozen
(`isImmutable` is "frozen or canonical"). Why: D16.

---

## 5. Extension: making your own types values

### 5.1 The protocol

The three value-protocol symbols, cross-realm registered as
`Symbol.for('valsem.<name>.v1')` (D4); the fourth protocol symbol,
`toDraft`, belongs to §7.1:

| Symbol | Tier | Shape |
| --- | --- | --- |
| `equals` | **comparable**: `deepEqual` answers by content | `[equals](other): boolean` on the prototype; also the kind discriminator |
| `hashCode` | **a value**: hashable, internable, a key, state | `[hashCode]: number` as property, getter or method; declares immutability (D26) |
| `interned` | **auto-interning type**: every instance canonical by construction | `[interned]: true`; requires a private constructor (D27) |

The registry form for types you cannot edit: `deepEqual.register(Type,
equalsFn)` makes it comparable; `deepEqual.register(Type, equalsFn, hashFn)`
makes it a value. Registering again replaces both handlers. Dispatch keys
on the prototype's constructor. `register` refuses a hash for the mutable
built-ins; an equality alone is accepted for them (the contained escape
hatch: `deepEqual.register(Date, (a, b) => a.getTime() === b.getTime())`).

A class instance with `[equals]` alone is comparable and refused by every
admitting operation with an error naming the missing hash.

### 5.2 `createInternPool`

`createInternPool<T>()` gives a class its own typed weak pool (§4.2). The
pattern: a private constructor, a static factory that builds the instance,
sets `[hashCode]`, and returns `pool.intern(p)`; the class declares
`[interned]: true`. Per-class pools need no type tag in their hashes.

### 5.3 Temporal

`import 'valsem/temporal'` registers, for `PlainDate`, `PlainDateTime`,
`PlainTime`, `PlainYearMonth`, `PlainMonthDay`, `Instant`, `ZonedDateTime`
and `Duration`, an equality and a hash. For six kinds the equality is
Temporal's own `equals()` and the hash is over the canonical `toString()`.
`Duration` compares field-wise over its ten fields and `ZonedDateTime` over
`epochNanoseconds`, `timeZoneId` and `calendarId`, each hashed over the
same fields (D5). Temporal values pool unfrozen. A kind absent from the
runtime is skipped; a present kind whose prototype lacks `equals` makes
registration throw; no `Temporal` global at all throws. `registerTemporal()`
is the same registration, callable and idempotent. Without the import,
Temporal values fall to reference semantics and `deepHash` throws naming
the import.

---

## 6. Collections

### 6.1 The plain-data doctrine

1. **Plain data by default.** Records and lists are plain frozen objects
   and arrays; `produce` edits them with plain syntax.
2. **Classes only where JavaScript lacks the primitive**: sets, value-keyed
   maps, ordered maps, and even then duck-typed to the native readonly
   interfaces.
3. **Optimised types are opt-ins** for measured hot paths (`ValueList`,
   `InternedString`, `RawArray`).
4. **Optimisations are invisible.** Same syntax, same semantics.

No collection impersonates a native type: a `ValueList` is not an array
and does not pretend to be (D29).

### 6.2 What every collection shares

- **Canonical instances.** Equal content is one `===` object, lineage-free:
  however a collection was built, it converges on the same instance. Each
  class carries `[hashCode]` (a getter over a private field, so no own
  symbol property exists and a spread copy carries no marker), `[interned]`
  (`true`), and `[equals]` (`===`).
- **Intern on entry.** Keys, values and members are interned as they
  arrive; probes are interned before lookup; internally slots compare by
  SameValueZero, which on canonical contents *is* structural equality
  (D32).
- **Encapsulated backing.** The trie or tree is a `#private` field; the
  instance itself is frozen. The class *is* the readonly interface:
  `ValueMap` and `OrderedMap` implement `ReadonlyMap`; `ValueSet` and
  `OrderedSet` carry the `ReadonlySet` read API. `new Map(m)` / `new
  Set(s)` for a mutable copy (D30).
- **Persistent updates.** Mutators return the canonical successor; an
  unchanged write returns `this`.
- **Explicit-stack iterators** extending the global `Iterator` where it
  exists, so the ES2025 helpers work (D6).
- **Drafting** through `[toDraft]` (§7), with a mutable twin per class.

### 6.3 `ValueMap` / `ValueSet`: the hash-consed CHAMP trie

`hamt.ts` is one trie shared by four classes at three strides: `ValueSet`
(stride 1, member), `ValueMap` (2, key + value), `OrderedSet` (2, member +
anchor), `OrderedMap` (3, key + value + anchor). Slot 0 of an entry is the
key; trailing slots are opaque payload compared by SameValueZero.

**Structure.** A bitmap node carries `dmap` (inline entries), `nmap` (child
nodes), and one dense slot array indexed by popcount: entry slots (stride
each, in bit order) followed by child slots. Five bits of the key hash per
level, 32-way branching, at most seven levels; entries whose keys share a
full 32-bit hash live in a collision node at the bottom. Every node also
carries `h`, its consed content hash, and `n`, the entries in its subtree.

**Consing.** Every node allocation goes through an intern pool: before a
node is created, an existing node with the same bitmaps and pairwise-same
slots is returned instead. Children are consed before parents, so a shallow
slot comparison is a deep one by induction, and two tries with equal content
are the same root object. Consing is sound because the shape is a pure
function of content: insertion order cannot matter (hash-directed shape);
deletion restores exactly the shape insertion would build (a subtree
collapsing to a single entry is inlined upward, unwinding prefix chains;
a non-root node never has arity < 2); collision-node entries keep a
canonical order (primitives by type and value, objects by a lazily assigned
per-instance ordinal, sound because members are identities within a
process). Why: D31.

**The wrappers.** A `ValueMap` is `{ #root, #hash = root.h }`, canonicalised
through a `WeakMap<root, wrapper>`: ephemeron semantics, no scan. `size` is
`root.n`. `get`/`has` walk at most seven nodes; `set`/`delete` path-copy at
most seven. The map's `[hashCode]` is the root hash.

**Set algebra.** `union`, `intersection`, `difference`,
`symmetricDifference`, `isSubsetOf`, `isSupersetOf`, `isDisjointFrom` take
any iterable of values, decide membership by this set's equality (never the
argument's `has`), and return `ValueSet`s. Two `ValueSet`s merge at node
level: where the tries share a node by pointer the result shares it too, so
the cost is proportional to where the operands differ, O(1) for the same
set. `ValueSet` is a `ReadonlySetLike` and does not spell `implements
ReadonlySet` (the lib's algebra signatures return a native `Set`).

**Iteration order** is the trie's structure: content-determined, arbitrary
by design (§2.4).

### 6.4 `ValueList`: the content-chunked tree

A `ValueList` is `{ #root: CNode | null, #tail: unknown[], #hash }`. The
closed runs form a tree of consed nodes; the open last run is a plain tail
array, so `push` and `pop` are array copies and the tree is touched only
when a run closes.

**Chunking rule.** A leaf run ends after any element whose hash says
"boundary" (`Math.imul(h, 0x9e3779b1) >>> 27 === 0`, one in 32) or at 64
elements. A branch run ends after any node whose hash says so under the
same test with a different salt, with at least two nodes per run so every
level shrinks, and at 64. Because a boundary is a property of the elements
beside it, the shape is a function of the sequence alone: equal content is
the same node however it was built, and an edit disturbs only the runs
around it, resynchronising with the untouched remainder at the next
boundary. Why: D18.

**Nodes.** `{ h, n, ht, kids, offsets, first }`: consed hash, elements
covered, height (1 for a leaf), the kids (elements at height 1, nodes
above), per-kid start offsets on branches, and the first element under the
node (the anchor the ordered collections address a run by, §6.5). One node
pool for all heights.

**One algorithm, `merge`.** Given a left context (the path to a cut), head
elements, and a cursor over a right context (the remainder of a list after
a cut), re-chunk level by level until each level resynchronises with the
right context's existing nodes, at which point the parent and everything
after it are reused by pointer. `from`, `push`, `splice`, `concat` and
`slice` are all calls to it. `insert` and `remove` are splices. `set` is a
path copy when no boundary flips, else a local re-chunk. `setMany` applies
a batch of point edits in one bottom-up pass. The bounds are expected on
the seeded hash, with no amortised rebuild anywhere.

**Reads.** `get(i)` walks size tables, with the last leaf cached so
sequential reads stay in one leaf; `length` is `root.n + tail.length`;
iteration streams leaves. `toArray()` is the **interned** flat array,
weakly memoised per instance (`WeakMap<list, WeakRef<array>>`), with
`toArray()[i] === get(i)` and `list.toArray() === intern([...sameContents])`
(D33). `ValueList.diff(a, b)` returns the changed regions (`Hunk`s) between
any two lists by descending both trees and skipping shared nodes by
pointer.

**Anchors** (used by §6.5). Each ordered collection keeps, per key, its
anchor: the first element of the lowest node on the key's path that the key
does not itself start (the list's first element anchors to `_ANCHOR_ROOT`,
tail elements to `_ANCHOR_TAIL`). Following anchors upward yields the
firsts of the non-first kids on the key's path, and a descent matching them
against each node's kids finds the index in O(log n) (`_indexOf`). Every
anchor a tree implies is contributed by the node whose kid it names, so
after an operation the anchors that may have changed are exactly the
contributions of the nodes it consed: `_record(fn)` collects those (pool
hits included), and `_anchorUpdates(consed, next)` turns them into a
key → anchor map, later nodes overriding superseded ones.

### 6.5 `OrderedMap` / `OrderedSet`

An `OrderedSet` is a `ValueList` of the members (the order, and the value:
the set *is* its member sequence) plus a stride-2 trie from member to
anchor. An `OrderedMap` is a `ValueList` of the keys, a parallel
`ValueList` of the values, and a stride-3 trie from key to value and
anchor. The trie is a function of the lists, so the wrapper pools on the
lists alone (`OrderedMap`: hash of the two list hashes; hit when both lists
are `===`). `keyList` and `valueList` are public: two maps with the same
keys in the same order share one key list whatever their values did.

Operations: `get`, `has`, `indexOf`, `at`, `keyAt`, `valueAt`, `first`,
`last`, `set` (a present key keeps its position; a new key appends),
`delete`, `insertAt`, all O(log n) expected. A structural edit runs the
list operation under `_record`, sets or removes the trie entry (a new key
anchors to the tail), then applies the anchor updates the consed nodes imply
(`applyAnchorUpdates`: keys the trie no longer holds are skipped, and so
are unchanged anchors, at one lookup each). Iteration is in order. `OrderedSet` has no set algebra (a union has
no single natural order); `ValueSet.from(orderedSet)` for that. Why: D23.

### 6.6 `HashMap`, `HashSet`, `memoize`

`HashMap` is a native `Map` keyed by canonical keys: every key is
`intern`ed on `set` and on every lookup, values are stored as-is,
`getOrCreate` avoids the has/get/set dance, and iteration yields canonical
keys. `HashSet` is its twin. Values stored as-is is the point: `HashMap` is
where value keys meet live mutable objects (D15).

`memoize(fn, { maxSize = 1 })` caches results keyed on the argument tuple by
value: each argument is `internHash`ed (raw arguments are walked), the
hashes are folded, and a bucket in a private strong `HashTable` is matched
by `deepEqual` per argument against the stored, interned arguments (a
pointer compare when the caller's argument is canonical). On a miss the
arguments are interned and stored. Results are interned; a result `intern`
refuses is rejected. Eviction is LRU through a doubly linked list;
the cache holds arguments and results strongly. `clear()` and `size` are on
the memoized function. Why: D14.

### 6.7 `InternedString`, `ValueDate`, `RawArray`

`InternedString.for(text)` is an opaque, pooled wrapper holding `value` (the
string, public because a primitive is genuinely immutable) and its hash,
paid once per distinct text; `toJSON` returns the text (D17).

`ValueDate.of(x)` accepts what `new Date(x)` accepts, parses it the same
way, rejects an invalid date, and pools on epoch milliseconds. `epochMs`,
`toDate()` (a fresh mutable `Date`), `valueOf()` (the epoch, so `<` and
subtraction work), `toJSON()` (the ISO string, as with a `Date`).

`RawArray.from(rawArray)` holds a raw array and admits elements on demand:
`get(i)` returns one canonical element, `slice(a, b)` the canonical array
of a range, each element interned once and memoised per slot; raw slots
are released as they are admitted. It has no iteration. Its value is its
identity: an identity `[hashCode]`, `[equals]` is `===`, marked
`[interned]`, so it sits in canonical state as an opaque leaf that `intern`
and `produce` return as-is (D21).

---

## 7. `produce`

```ts
produce(base, draft => { draft.user.email = 'x@y.dk'; draft.tags.add('vip'); });
```

`intern(x) ≡ produce(x, () => {})`. Finalize cost is proportional to the
drafted spine plus grafted foreign material, never to what is already
canonical. `produce(canonical, noop)` returns the same reference;
`produce(foreign, noop)` returns the canonical equivalent; a recipe whose
edits net out returns the base and emits zero patches. Why: D35.

### 7.1 The protocol and the scope

A `produce` call opens a **scope**; every draft state created inside it is
recorded there and revoked when the recipe returns (a proxy's `revoke` is
called; a class draft checks `revoked` on every operation). A draft from
another scope cannot be assigned in (`assertAssignable`).

A value becomes draftable by implementing `[toDraft](parent)` on its
prototype, returning a `DraftState` built with `createDraftState`:

| Field | Role |
| --- | --- |
| `kind`, `base`, `parent`, `scope` | identity and position |
| `modified` | set by `markChanged`, bubbles to the root |
| `draft` | what the recipe receives |
| `finalize(state, path, recorder)` | the canonical result; emits this container's patches when `path` is not null |
| `applyPatch?`, `childAt?` | how `applyPatches` reaches and navigates through this kind |
| `snapshot?` | the value as it stands now, for `current()` |
| `revoke?` | proxies revoke; classes need not |
| `result`, `finalized`, `revoked` | memoisation and lifecycle |

Plain objects and arrays are the two kinds `produce` itself registers with
`draft-core` at import (`_setCoreDraftFactories`); every other kind,
the built-in collections included, arrives through the protocol. The
toolkit is exported as `valsem/draft`: `createDraftState`, `markChanged`,
`assertUnrevoked`, `assertAssignable`, `createChildDraft`, `resolve`,
`restoreValue`, `snapshotOf`, `isDraftable`, `isDraft`, `stateOf`,
`isImmutable`, `same`, and the sequence-patch helpers `emitSeqOps`,
`retractSeqPatches`, `seqTailProfile`. Why: D7.

### 7.2 Draft kinds

- **Plain records: revocable `Proxy`** over the base, with a shallow copy
  made on first write (§7.3), an `assigned` map (key → set/deleted) and a
  `drafted` set (keys whose base value was child-drafted on read). Reads of
  a draftable base value hand out a child draft; reads of the recipe's own
  assigned material return it raw (the immer rule), except frozen or
  canonical assignments, which are drafted copy-on-write so mutating
  through the read never throws. Writing a protocol symbol is rejected.
- **Plain arrays: `Proxy`** with a **virtual mode**: point edits
  (`vEdits`) plus an appended tail (`vTail`) over the base; index reads and
  writes and `push` never copy, and `pop` stays virtual while the appended
  tail is non-empty; iteration and the read-only methods work virtually
  through prototype dispatch. Any other structural op (`shift`, `unshift`,
  `splice`, `sort`, `reverse`, `fill`, `copyWithin`, `length` writes,
  sparse growth, a `pop` reaching the base) and an `ownKeys` read
  materialise a working copy. Mutating methods are intercepted and recorded
  as `SeqOp`s
  (`set` and `splice`) while intent is capturable; `ops` becomes null once
  it is not. `opaqued` marks that base elements may sit at foreign indices,
  after which any draftable read is drafted.
- **`DraftMap`**: an overlay of edits (canonical key → draft or raw value)
  and an `assigned` map over the base; finalize sets the resolved edits
  into the base map. **`DraftSet`**: `added`, `removed`, `cleared`;
  members have no location, so `add`/`delete`/`clear` only.
- **`DraftList`**: never materialises. A persistent working `ValueList`
  tracks positions (every structural op applied at O(log n) as it happens,
  with placeholders where new elements went) and an overlay from current
  index to what the recipe sees there; a splice re-indexes the overlay in
  O(edits); finalize resolves the overlay onto the working list.
- **`DraftOrderedMap` / `DraftOrderedSet`**: a persistent working
  collection with every structural op applied as it happens, a value
  overlay (map only), and an op log in operation order for patches.

Each draft class stores its state under a non-enumerable `DRAFT_STATE`
property; `isDraft`/`stateOf` read it. Why: D36, D39.

### 7.3 Plain-record copies

The first write to a record draft copies the latest base with
`Object.assign({}, base)`, not spread: a library's single copy site sees
every shape in the application and object spread's inline cache degrades
past four shapes, while `Object.assign`'s builtin fast path keys on the
source map (D8). A base with an own `__proto__` key is spread instead,
because `Object.assign`'s [[Set]] would swallow that key. Membership tests
use own properties only, never `in`.

### 7.4 Finalize: the intern walk

`resolve(value, path, recorder)` is the one function every kind calls on
its children: a draft finalizes (memoised per state, so aliased drafts
converge on one canonical); anything else `adopt`s. `adopt` passes
primitives (with `-0` → `+0`), recognises canonical material in O(1) by the
hash cache or the `[interned]` marker, and otherwise walks foreign plain
data for embedded drafts and interns the result (a value type pools; any
other class or a mutable built-in throws its teaching error). `adopt` is
depth-capped under the `produce` name. `finalizeState` interns the base of
an unmodified state and delegates a modified one to its kind.

**Record finalize** builds the successor from the copy, resolving each
assigned or drafted key, restores `base[key]` where a child netted out,
delta-updates the base's accumulator by the changed entries, and interns
the successor prehashed (`_internPrehashed`: pool lookup by shallow
equality, then meta, freeze, register). Records without a cached
accumulator go through `intern`.

**Array finalize** has a fast path when the base has an accumulator and the
recorded ops keep positions stable below a low-water mark
(`seqTailProfile`: point sets plus tail splices): resolve the touched
indices below the mark and the rewritten region above it, delta-update the
accumulator, and, before building anything O(n), consult the **transition
cache**: a `WeakMap` from canonical base to its 16 most recent transitions
`{ hash, length, touched indices, their values, appended region, WeakRef
successor }`. A match on base identity and exact delta *proves* the result
with no hash trust and no walk; a miss builds the successor with `copyArr`
and interns it prehashed, then stores the transition. Everything netting
out returns the base and retracts this container's patches. The slow path
materialises, resolves every slot, interns, and, when intent was lost,
emits a net index diff. `copyArr` keeps an unfrozen **shadow** of a frozen
base of 64+ elements in a `WeakMap`, built on the second copy of the same
base, because V8's `slice` fast path excludes frozen-elements arrays. Why:
D38.

### 7.5 Patches and `applyPatches`

`produceWithPatches` returns `[result, patches, inverse]`. The vocabulary
(`PatchKinds`, extensible by declaration merging for exact narrowing):

| Kind | Fields |
| --- | --- |
| `replace` | `path`, `value` (a recipe returned a replacement) |
| `record.set` / `record.delete` | `path`, `key`, (`value`) |
| `list.set` / `list.splice` | `path`, `index`, (`value`) / `remove`, `insert` |
| `map.set` / `map.delete` | `path`, `key`, (`value`) |
| `set.add` / `set.delete` | `path`, `value` |
| `omap.set` / `omap.delete` / `omap.insert` | `path`, `key`, (`value`), (`index`) |
| `oset.add` / `oset.delete` / `oset.insert` | `path`, `value`, (`index`) |

Paths are record keys, sequence indices, or under a map the canonical key
value itself. Record, map and set patches are net per container
(assignment maps); sequence patches replay recorded ops; ordered patches
replay the recipe's operations in order. Forward values are canonical;
inverse values resolve drafts to their base (`restoreValue`). Emission
precedes result knowledge, so a container that finalizes to its base
retracts its own entries. Symbol keys appear in patches as symbols, and are
not serialisable.

`applyPatches(base, patches)` runs each maximal run of non-`replace`
patches as one `produce` whose recipe walks each path through the live
draft (own keys, in-range integer indices, a kind's `childAt`; anything
else throws), type-checks keys and indices, and calls the kind's
`applyPatch` or edits the core draft; a root `replace` ends a run and
starts the next on its value. Patch values are interned on application.
`applyPatches(base, patches) === produce(base, recipe)`. Why: D37.

### 7.6 `current` and `original`

`original(draft)` is the state's base. `current(draft)` is `intern` of
`snapshotOf(draft)`: an unmodified draft snapshots to its base; a modified
one calls its kind's `snapshot` (the core object/array snapshots are
registered from `current.ts`, so a `produce`-only bundle carries neither);
foreign material is walked for embedded drafts. Both throw on a non-draft
and on a revoked draft; `current` also throws on a kind without
`snapshot`. Why: D13.

### 7.7 Types

`Draft<T>`: a `[toDraft]` implementer maps to its draft class; a record or
array maps member-wise and writable; a type with any function-typed member
(symbol-keyed methods included) is a class instance and maps to itself, an
opaque leaf. `Undraft<D>` is the inverse, read from the draft's
`DRAFT_STATE`. `RecipeReturn<T>` is `void | undefined | T | Draft<T>`, plus
`nothing` where `T` admits `undefined`. The curried overload reads the
producer's type off the recipe (`_CurriedFromRecipe`), accepting a frozen
spelling of the state. A recipe that returns a thenable is rejected as
`async` (D39); one that both mutates and returns is rejected.

---

## 8. Performance model

Finalize cost is the sum over drafted containers along changed spines; a
child compares `===` and has a cached hash, so cost is container *width*,
never subtree size:

| Container | finalize per drafted container |
| --- | --- |
| plain record / array | O(width): the copy itself; the hash is O(changes) |
| CHAMP-backed map / set | O(edits · log₃₂ n) |
| content-chunked list | O(edits · log n) expected; `push` is a tail-array copy |

Plain data scales with depth; the optimised structures scale with width.
Records are schema-narrow by nature, so plain is safe for them; sets and
maps are the unbounded collections and are already the class-typed
citizens; lists are the one manual choice.

Three tiers for hot loops, cheapest first: batch edits inside one
`produce` (one pool transaction per recipe); keep in-flight state plain and
canonicalise at commit boundaries (drag end, debounce, frame); opt into
the O(log n) structures when the *committed* value is wide and edits are
frequent. What the design buys is downstream of the write: `===` memo hits
on refetched data, O(1) hashing, one copy of equal data process-wide, and
history that costs its distinct states (D40). Numbers: BENCHMARKS.md.

---

## 9. Hardening

- **Records are their own keys.** Every walk (equality, hashing,
  interning, drafting, snapshots) enumerates own enumerable keys and reads
  with `hasOwn`, never `in` or `for…in`; a `__proto__` key in input becomes
  an own data property (`defineRecordField`); holes canonicalise to
  `undefined`; registry dispatch keys on the prototype's constructor.
- **Patches are validated.** Paths follow own keys, in-range integer
  indices and a kind's `childAt` only; keys and indices are type-checked;
  values are interned on application.
- **Depth cap.** `intern`, `deepHash`, `produce`'s adopt and `current`'s
  snapshot walk are capped by `configureLimits({ maxDepth })`, default 512,
  reconfigurable at any time, with a teaching error; cyclic input hits the
  cap. `deepEqual` is uncapped and total over admitted values; on raw cyclic
  input it recurses until the engine throws. There are no size limits.
- **Seeded hashing** (§3.3) closes hash flooding; `configureHasher` is
  one-shot.
- **Weak pools** hold nothing alive (§4.2).

Why: D19, D28. Tested in `src/hardening.test.ts` and `src/adversarial.test.ts`.

---

## 10. Package layout

### 10.1 `valsem/binding`

The stable surface for binding authors: `defineRecordField(record, key,
value)`, the `__proto__`-safe record-field writer; `mutableBuiltinReason(
ctor)`, the shared rejection text. No "is this type a value" probe exists;
a binding calls `intern` and learns the answer per instance (D41).

### 10.2 Module map

| Module | Responsibility |
| --- | --- |
| `shared.ts` | `same` (SameValueZero), `sameSlots`, `IteratorBase`; a leaf with no imports |
| `hasher.ts` | seed, `mix`, Marvin32, `configureHasher`, `getHashSeed` |
| `limits.ts` | the depth cap |
| `checks.ts` | `skipChecks`, `skipFreezing`, `_freeze` |
| `deep-equal.ts` | protocol symbols, the registry, the mutable-built-in table, `deepEqual`, the dev warning |
| `deep-hash.ts` | the hash cache and canonical meta, accumulators, symbol hashes, `deepHash` |
| `intern-pool.ts` | `InternPool`, slots, the registry and idle drain, `createInternPool` |
| `intern.ts` | `intern`, `isCanonical`, `fastEquals`, `internHash`, `_internPrehashed` |
| `hamt.ts` | the consed CHAMP trie at strides 1–3, node-level set algebra |
| `value-map.ts`, `value-set.ts` | wrappers over the trie |
| `value-list.ts` | the content-chunked tree, `merge`, `diff`, anchors |
| `ordered-core.ts`, `ordered-map.ts`, `ordered-set.ts` | the ordered collections |
| `hash-map.ts`, `hash-set.ts`, `hash-table.ts`, `memoize.ts` | the mutable side |
| `interned-string.ts`, `value-date.ts`, `raw-array.ts` | the opt-in leaves |
| `draft-core.ts` | scope, `DraftState`, `resolve`/`adopt`/`finalizeState`, snapshots, sequence-patch helpers; the surface of `valsem/draft` |
| `produce.ts` | record and array proxies, array finalize with transitions, `produce`, `produceWithPatches`, `applyPatches`, the types |
| `current.ts` | `current`, `original`, the core snapshots |
| `draft-map.ts`, `draft-set.ts`, `draft-list.ts`, `draft-ordered-map.ts`, `draft-ordered-set.ts` | the collection drafts |
| `temporal.ts`, `binding.ts`, `draft.ts`, `index.ts` | the entry points |

Dependency direction: `shared`, `hasher`, `limits`, `checks` and
`deep-equal` are leaves; `deep-hash` and `intern-pool` sit over them as
independent siblings; `intern` is the first module to import both; then
`hamt`, the collections and `draft-core`; then `produce`; then `current`.
`produce` never imports a collection; a collection never imports `produce`
(it imports `draft-core` and its own draft module).

### 10.3 Tests and benchmarks

Vitest suites sit beside the modules. Property suites (fast-check):
`property-laws` (companion invariant, intern idempotence over shuffled
clones), `property-values`, `property-set-algebra`, `property-ordered`,
and `property-produce`, which runs an op interpreter against a draft and a
frozenness-preserving mirror of the base with every oracle `===`, the
executable specification of `produce` (D39). `produce-corpus*.test.ts`
carry the immer and mutative adversarial corpora. `hamt-collisions` runs
the trie under a degenerate hasher. `duplicate-install` pins the
two-copies behaviour (D4).

`bench/suites/*.mjs` are the suites `pnpm bench` runs on Node and Bun;
`bench/report.mjs` renders BENCHMARKS.md from their JSON; the methodology is
D20. `scripts/experiments/` holds the one-off experiments behind decisions
(pool cleanup strategies, retention regimes, the in-job `WeakRef` effect).

### 10.4 Documentation

The guide is a VitePress site under `docs/` (`pnpm docs:build`, after
`pnpm build`: the demo imports the compiled `dist/`), published to GitHub
Pages by `.github/workflows/docs.yml`. `docs/benchmarks.md` includes
BENCHMARKS.md and `docs/guide/getting-started.md` includes the README's
sixty-seconds region, so each text exists once. `docs/demo.md` is the
undo-tree demo: a document editor whose history is an identity `Map` keyed
by canonical states. TSDoc on the exports is the per-symbol reference.

---

## 11. Design laws

1. **Companion invariant**: every equality ships a hash; `equal ⟹ same
   hash`.
2. **Only immutable things get value identity**; `Object.freeze` is not a
   proof of immutability, and a hash is the declaration.
3. **`undefined` is not a value in records; `null` is.**
4. **Order is semantic exactly where the type says so**: never on records,
   `ValueMap`, `ValueSet`; always on arrays, `ValueList`, `OrderedMap`,
   `OrderedSet`.
5. **Ergonomics is the contract; performance is the implementation.** Plain
   data by default; classes only where JavaScript lacks the primitive;
   optimised types are opt-ins; optimisations are invisible.
6. **Values may not lie about their kind**: no structural liars, no proxy
   facades; visible wrappers are honest type distinctions.
7. **Properties are O(1); methods may cost.**
8. **O(1) caches may be strong; O(n) caches must be evictable**, because
   canonical lifetimes are long by design.
9. **Pool membership is the universal marker**: finalize skipping, draft
   scoping, node canonicalisation.
10. **Finalize cost ∝ drafted spine + foreign material**; depth is free,
    width is the cost.
11. **Fail loud at the boundary, never silently downstream**: rejection
    with teaching errors; `__proto__`-safe record building; strict draft
    revocation; `deepEqual` alone stays total.
12. **Representation is public exactly where the platform can enforce
    immutability**: frozen arrays and strings yes; trie and tree backing no.
13. **Nothing that affects an answer reads the environment.** The two
    switches are the user's; the one thing gated on `NODE_ENV` is the
    development warning in `deepEqual`, which changes no verdict.
