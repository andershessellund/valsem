# valsem

**Value semantics for JavaScript** — structural equality, companion hashing,
global interning, and immutable value collections.

```bash
npm install valsem
```

> Requires a runtime with `WeakRef` and Web Crypto (`globalThis.crypto`,
> which seeds the flood‑resistant hasher) — that is: Node ≥ 19, and all
> current browsers, workers, Deno, and Bun. `FinalizationRegistry` is
> optional — when present, valsem uses a single sentinel as a GC‑epoch hint
> for pool cleanup, never one cell per value. Ships as ES modules with full
> TypeScript types.

---

## Why

JavaScript objects have **reference identity**. Two objects that look the same
are not equal, cannot be used interchangeably as keys, and cannot be
deduplicated:

```ts
{ x: 1, y: 2 } === { x: 1, y: 2 };            // false
new Map().set({ id: 1 }, 'a').get({ id: 1 }); // undefined — different reference
```

For a lot of code — reactive state, caches, query results, event sourcing,
graph nodes, coordinates, money — what you actually want is **value
semantics**: two things are "the same" when their *contents* are the same. The
usual workarounds are unsatisfying: `JSON.stringify` comparison is slow, fragile
(key order, `undefined`, `bigint`, `NaN`), and allocates; hand‑written `equals`
methods drift out of sync with hashing; and building an immutable "value type"
means a lot of boilerplate.

`valsem` provides value semantics as a small, composable toolkit:

- **`deepEqual` / `deepHash`** — structural equality and a *companion* hash that
  respects it (`deepEqual(a, b)` ⟹ `deepHash(a) === deepHash(b)`).
- **`intern`** — collapse every structurally‑equal value to a single, frozen,
  canonical instance, so **value equality becomes `===`** and hashing becomes an
  O(1) cache read.
- **`produce`** — mutate a draft with ordinary syntax, receive the canonical
  result (plus optional semantic patches): the immer ergonomics, ending in
  interned values.
- **Value collections** — `HashMap` keyed by structure, and the persistent
  `ValueList` / `ValueMap` / `ValueSet` / `InternedString` whose *instances*
  are canonical (equal contents ⟹ same reference).
- **Extension points** — the `equals` / `hashCode` / `interned` symbols,
  `deepEqual.register`, and `createInternPool` let any type become a first‑class
  value.
Everything is dependency‑free and tree‑shakeable. Serialization is deliberately
out of scope: valsem defines what "the same" *means*; carrying values across a
wire is a separate layer's job (see
[Serialization is out of scope](#serialization-is-out-of-scope)).

---

## Structural equality and hashing

Start with the two primitives everything else is built on.

```ts
import { deepEqual, deepHash } from 'valsem';

deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 }); // true  — key order is irrelevant
deepEqual([1, 2, 3], [1, 2, 3]);           // true
deepEqual([1, 2], [2, 1]);                 // false — array order is significant

deepHash({ x: 1, y: 2 }) === deepHash({ y: 2, x: 1 }); // true
```

`deepEqual` dispatches on the runtime kind of its arguments and handles
primitives (including `NaN` and `±0`), plain objects (key‑order‑independent),
and arrays (order‑sensitive). Plain‑object comparison is recursive.

`deepEqual` also **consults canonicality**: because equal content collapses to
one canonical instance, two *distinct* canonical values compare unequal in
O(1) — no walk — and comparisons of mixed trees terminate at every canonical
boundary. Interning your data makes `deepEqual` fast retroactively.

`deepHash` is its **companion**: whenever `deepEqual(a, b)` is `true`,
`deepHash(a) === deepHash(b)` is guaranteed (the converse is not — hashes can
collide). Arrays hash order‑dependently. `deepHash` throws for values it cannot
hash consistently — symbols, functions, class instances with no registered
handler, and the mutable built‑ins below.

### Mutable values are not values

`Date`, `RegExp`, `Map`, and `Set` are **not supported**. valsem gives value
semantics to immutable values only: a canonical instance is shared by every
holder, so one mutation would corrupt all of them *and* invalidate the hash
cached against it. `deepHash` and `intern` both reject them, naming the
immutable replacement:

| Instead of | Use |
| --- | --- |
| `Date` | `Temporal.Instant` — `Temporal.Instant.fromEpochMilliseconds(d.getTime())`, with [`valsem/temporal`](#temporal-valsemtemporal) |
| `RegExp` | a plain `{ source, flags }` record — a regex is behavior, not data |
| `Map` | [`ValueMap`](#persistent-collections--canonical-instances) |
| `Set` | [`ValueSet`](#persistent-collections--canonical-instances) |
| `TypedArray` / `DataView` / `ArrayBuffer` | a hex or base64 string — bytes are rewritable through *any* view over the same buffer, so no instance can be immutable |

(When TC39's immutable‑`ArrayBuffer` proposal ships, a view over a buffer with
`.immutable === true` is a genuine value, and TypedArray support can return
gated on that check.)

```ts
deepHash(new Date(0));        // throws — names Temporal.Instant
intern({ at: new Date(0) });  // throws
intern(new Set([1]));         // throws — names ValueSet.from
```

`deepEqual` is the one exception — deliberately total, and not as a
concession. For mutable objects, **reference equality is the correct
answer**: equality means observational substitutability, and two distinct
`Date`s are not substitutable — one `setTime()` later they observably
diverge. Content comparison over independently‑mutable objects asserts a
sameness their mutability falsifies, so the honest report is *unequal*.
Totality also lets `deepEqual` sit safely in positions that must not throw —
memo comparators, dedup gates — while the throwing happens where it belongs:
at the boundaries that admit data into value‑land (`deepHash`, `intern`, the
collections, `produce`), each error naming the immutable replacement. If you
need to know why two things are unequal, hash one.

Because the reference answer is correct *and* famously surprising, comparing
two **distinct instances of the same mutable built‑in** logs a one‑time
development warning naming the replacement (`new Set()` vs `new Set()` is the
classic first encounter). Production builds stay silent; nothing ever throws.

If your application truly wants, say, Date‑by‑time equality, the escape hatch
exists and is **contained**: `deepEqual.register(Date, (a, b) => a.getTime()
=== b.getTime(), d => d.getTime() >>> 0)` makes `deepEqual`/`deepHash` answer
for Dates — while `intern`, the collections, `produce`, and `HashMap` keys
still refuse them (rejection is independent of registration). The risk you
accept is the classic one: a hash taken from a mutable object goes stale the
moment it mutates, and structures you key by it will silently miss. That
silent miss is precisely why these types are not values by default.

A class instance with neither an `[equals]` method nor a registered handler
falls back to **reference semantics** (`deepEqual` is `Object.is`); `deepHash`
throws, because it has no safe, content‑based hash to offer. (See
[Making your own types values](#making-your-own-types-values).)

---

## Interning: value identity via `===`

`deepEqual` answers "are these equal?" one comparison at a time. **Interning**
goes further: it replaces every structurally‑equal value with one shared
canonical instance, so from then on ordinary `===` *is* value equality.

```ts
import { intern } from 'valsem';

const a = intern({ city: 'Aarhus', zip: '8000' });
const b = intern({ zip: '8000', city: 'Aarhus' });

a === b; // true — same frozen canonical object
```

`intern` walks the value bottom‑up: it interns children first, then looks the
whole value up in a global pool keyed by `deepHash`. On a hit you get the
existing instance back and nothing is allocated; on a miss the value is
**deep‑frozen**, its hash is cached, and it becomes the canonical instance.
That yields three properties at once:

1. **Value equality is `===`** — no per‑comparison traversal.
2. **Hashing is O(1)** — the hash is cached on the canonical instance.
3. **Sharing is automatic** — identical subtrees are stored once.

The pool holds values **weakly** (via `WeakRef`), so canonical instances are
garbage‑collected once you stop referencing them — interning does not leak
memory. Pool bookkeeping is reclaimed by an incremental, traffic‑driven
sweeper (plus a single GC‑epoch sentinel): a bounded constant tax on pool
operations, with no per‑entry finalizers, no monolithic cleanup passes, and no
timers.

```ts
import { deepEqual, internHash } from 'valsem';

deepEqual(a, { city: 'Aarhus', zip: '8000' });         // true — walks the raw side
deepEqual(a, intern({ city: 'Odense', zip: '5000' })); // false in O(1) — both canonical
internHash(a);                                          // cached hash, no traversal
```

**What can be interned.** Primitives are returned unchanged. Plain objects and
arrays are interned recursively. A class instance is interned only if it is
**declared immutable** — either by carrying its own pool (see
[`createInternPool`](#interned-value-types-with-createinternpool)) or by
registering with `{ immutable: true }`, which is how `valsem/temporal` makes
Temporal values canonical. Everything else passes through **untouched**.

`Date`, `RegExp`, `Map`, and `Set` **throw** here rather than passing through,
so that a mutable value can never reach a pool or a `HashMap` key and silently
fail to match. See [Mutable values are not
values](#mutable-values-are-not-values).

`Object.freeze` is not a way around this. It does not reach the internal slots
of a `Date` or a `Map`; on a `RegExp` it makes `lastIndex` read‑only, which
makes `.exec()` throw; and on a non‑empty `TypedArray` it throws outright —
whose bytes are rewritable through any other view over the same buffer anyway.

> **Interned values are frozen.** Treat interning as the boundary into
> immutable, shareable data. If you need to "change" an interned value, produce
> a new one (the value collections make this cheap).

---

## Value collections

### `HashMap` — a Map with structural keys

`HashMap` interns each key on the way in, so structurally‑equal keys — in any
field order — address the same entry. It is the drop‑in answer to "I want to key
a Map by an object's value".

```ts
import { HashMap } from 'valsem';

const cache = new HashMap<{ table: string; id: string }, Row>();
cache.set({ table: 'users', id: '1' }, row);
cache.get({ id: '1', table: 'users' }); // → row  (field order irrelevant)

// Avoid the has/get/set dance:
const row = cache.getOrCreate({ table: 'users', id: '2' }, loadRow);
```

`HashMap` is a mutable container (like `Map`); only its **keys** get value
semantics. Values are stored as‑is.

### Persistent collections — canonical *instances*

`ValueList`, `ValueMap`, `ValueSet`, and `InternedString` are **immutable**
collections whose *instances* are interned: two with equal contents are the same
reference (`===`), carry a precomputed `[hashCode]`, and can be compared,
deduplicated, and used as keys for free.

```ts
import { ValueList, ValueMap, ValueSet } from 'valsem';

ValueList.of(1, 2, 3) === ValueList.of(1, 2, 3);       // true
ValueMap.fromObject({ a: 1 }) === ValueMap.fromObject({ a: 1 }); // true
ValueSet.from([1, 2]) === ValueSet.from([2, 1]);          // true — unordered
```

Mutators are **persistent**: they return the canonical successor, sharing all
untouched structure and allocating nothing when the result already exists.
All three collections are backed by **hash‑consed trees** (a CHAMP trie for
`ValueMap`/`ValueSet`, a dense radix vector for `ValueList`): equal content
converges on the very same tree nodes process‑wide — however and in whatever
order it was built — so deep equality is a pointer comparison, an update
copies only an O(log n) path, and equal subtrees are stored once. Ideal for
hot state that churns through the same few configurations.

Elements, keys, and values are **interned on entry**: everything stored is a
canonical value or primitive. Structurally equal raw inputs converge
(`ValueList.of({ a: 1 }) === ValueList.of({ a: 1 })`), raw plain data is
frozen at the door — a stored element can never be mutated out from under its
cached hashes — and lookups canonicalize their probe, so `get`/`has`/`delete`
accept any structurally equal key.

```ts
const v0 = ValueList.empty<number>();
const v1 = v0.push(1).push(2);   // ValueList [1, 2]
const v2 = v1.pop();             // back to the canonical [1] — no allocation
v2 === v0.push(1);               // true

const m1 = ValueMap.fromObject({ hp: 3 }).set('sp', 5);
m1.get('sp');                    // 5
[...m1];                         // ValueMap *is* a ReadonlyMap — iterate it directly
```

`ValueMap` **is** a `ReadonlyMap` and `ValueSet` **is** a `ReadonlySet` —
pass them anywhere those are accepted (`ValueSet` includes the ES2025
set‑algebra methods). Their backing collections are private: JavaScript cannot
make a `Map` or `Set` immutable at runtime, so handing one out would let a
single accidental `set()`/`add()` corrupt the shared canonical instance. Take a
mutable copy with `new Map(m)` / `new Set(s)` when you need one.

`ValueList` is a hash‑consed radix vector behind the same rule: read with
`get(i)` (a few array hops), iterate in index order, and take the interned
frozen snapshot with `toArray()` — explicitly O(n), weakly memoized, with
`toArray()[i] === get(i)` always. `InternedString` *does* expose its
datum — `value` — because there the platform enforces immutability for real:
a string is a primitive. The rule: the representation is public exactly where
the runtime can actually protect it.

`InternedString` wraps a string and precomputes its hash once, turning repeated
`deepHash`/key lookups on the same string into O(1) reads.

---

## produce: mutate a draft, get the canonical value

`produce` gives you plain mutable syntax over immutable values — the immer
ergonomics — with one upgrade: the result is **canonical**. `intern` is the
degenerate case: `produce(base, () => {}) === intern(base)`, and edits that
net out structurally converge back to the canonical base for free.

```ts
import { produce } from 'valsem';

const state = intern({ count: 1, todos: ValueList.of('a') });
const next = produce(state, draft => {
  draft.count++;
  draft.todos.push('b');       // ValueList slots draft as a DraftList
});

next === intern({ count: 2, todos: ValueList.of('a', 'b') }); // true — canonical
next.todos === produce(state, d => void d.todos.push('b')).todos; // lineage-free
```

Plain objects and arrays draft through proxies (any syntax works, including
array methods); `ValueMap`/`ValueSet`/`ValueList` slots hand out
`DraftMap`/`DraftSet`/`DraftList` — mutable twins with the native-collection
API. Raw material assigned into a draft is **adopted**: interned on the way
into the result, exactly like the collections' intern-on-entry. Drafts are
revoked when `produce` returns — using a leaked draft throws.

`produceWithPatches` additionally returns **semantic patches** (and their
inverses): net `record.set`/`record.delete`, `map.set`/`map.delete`,
`set.add`/`set.delete` — and for sequences, *recorded* `list.splice` intent
rather than index diffs (a `DraftList.splice` is one patch, not n). Apply
them with `applyPatches`; because everything is canonical,
`applyPatches(base, patches) === produce(base, recipe)` — patch streams and
direct production converge on the same instance.

```ts
const [next2, patches, inverse] = produceWithPatches(state, d => {
  d.todos.splice(0, 1, 'z');
});
applyPatches(state, patches) === next2;   // true
applyPatches(next2, inverse) === state;   // true
```

Recipes follow the immer conventions: mutate the draft, or return a
replacement value (`nothing` for "the result is `undefined`") — never both.
The curried form `produce(recipe)` returns `base => produce(base, recipe)`.

---

## Making your own types values

Three well‑known symbols let any class opt into value semantics. Import them and
implement whichever the operation needs:

| Symbol       | Enables                          | Shape                            |
| ------------ | -------------------------------- | -------------------------------- |
| `equals`     | `deepEqual`                      | `[equals](other): boolean`       |
| `hashCode`   | `deepHash`                       | `[hashCode]: number` (or method) |
| `interned`   | auto‑interning type contract     | `[interned]: true`               |

```ts
import { equals, hashCode } from 'valsem';

class Money {
  constructor(readonly amount: number, readonly currency: string) {}

  [equals](other: unknown): boolean {
    return other instanceof Money
      && other.amount === this.amount
      && other.currency === this.currency;
  }

  get [hashCode](): number {
    return (this.amount * 31 + hashString(this.currency)) >>> 0;
  }
}

deepEqual(new Money(5, 'DKK'), new Money(5, 'DKK')); // true
```

Implement `equals` and `hashCode` **together** — the companion invariant
(`equals ⟹ same hashCode`) is what makes hashing and interning correct.

For third‑party types you cannot edit, register a handler pair globally:

```ts
import { deepEqual, deepHash } from 'valsem';

deepEqual.register(
  Money,
  (a, b) => a.amount === b.amount && a.currency === b.currency,
  (m) => deepHash(`${m.amount}|${m.currency}`),
);
```

Add `{ immutable: true }` as a fourth argument when instances genuinely cannot
change after construction; that makes the type internable, so `intern` collapses
equal values to one canonical `===` instance instead of passing them through.
Only claim it if it is true — the pooled instance is shared by every holder.

### Interned value types with `createInternPool`

To get canonical `===` instances for your own class — the same deal the built‑in
collections get — allocate a per‑class `InternPool` and route construction
through it. Give the class a `[hashCode]`, an `[equals]`, and let the pool
deduplicate:

```ts
import { createInternPool, equals, hashCode, interned } from 'valsem';

const pool = createInternPool<Point>();

class Point {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;

  private constructor(readonly x: number, readonly y: number) {}

  [equals](other: unknown): boolean {
    return other instanceof Point && other.x === this.x && other.y === this.y;
  }

  static of(x: number, y: number): Point {
    const p = new Point(x, y);
    (p as any)[hashCode] = (x * 73856093) ^ (y * 19349663);
    return pool.intern(p); // frozen, marked interned, deduplicated
  }
}

Point.of(1, 2) === Point.of(1, 2); // true
```

`pool.intern` freezes the instance, sets `[interned] = true`, and returns the
canonical copy — a cache hit discards the argument without allocating. A
per‑class pool needs no type tag in its hashes: there is no cross‑type collision
risk because each pool only ever holds one type.

The **private constructor is part of the contract**, not a style choice:
`[interned]` declares an *auto‑interning type* — every instance canonical by
construction, with no publicly reachable way to build one around the pool.
valsem leans on that: `intern` returns marked values without a lookup, and
`deepEqual` concludes on any non‑identical pair the moment either side is
marked (same type would mean both marked; a mixed pair is cross‑kind). A type
that exposes non‑interning construction must not carry the marker.

---

## Temporal: `valsem/temporal`

Temporal support is a side-effect import, so consumers who do not use Temporal
pay nothing for it:

```ts
import 'valsem/temporal';
```

That one line registers, for all eight Temporal types, an equality handler, a
companion hash, and an immutability declaration (so `intern` pools them).

```ts
import { deepEqual, intern } from 'valsem';

deepEqual(PlainDate.from('2026-08-31'), PlainDate.from('2026-08-31')); // true
intern(PlainDate.from('2026-08-31')) === intern(PlainDate.from('2026-08-31')); // true
```

Without the import, Temporal values fall back to reference semantics and
`deepHash` throws — with an error naming this import.

> **`Duration` compares field-wise, not by `Duration.compare`.** It is the one
> kind with no `equals()` method, and no total equality exists for it:
> `Duration.compare` calls `P1D` and `PT24H` equal but *throws* on `P1M` vs
> `P30D` without a `relativeTo`, and an equality that throws cannot back a hash
> table. So `valsem` compares a `Duration` on its canonical `toString()`:
> `PT0H` equals `PT0M` (both normalise to `PT0S`), while `P1D` does **not**
> equal `PT24H`. Normalise before valsem sees them if you need `compare`
> semantics.

---

## Serialization is out of scope

valsem defines what "the same" *means*; it does not define bytes. The split is
deliberate: a wire format that wants identity‑preserving decoding
(`decode(encode(x)) === x`) builds on valsem from the outside — decode into
plain data, `intern` the result, and equal payloads collapse to the same
canonical instance no matter when, or from where, they arrived.

The [`valsem/binding`](#valsembinding) subpath is the small, semver‑covered
contract for authors of such bindings.

---

## What exactly is "the value"?

Every operation in valsem — equality, hashing, interning — and every binding
built on it agrees on one definition of what each kind of thing *is*:

| Kind | Its value is |
| --- | --- |
| primitive | itself (`NaN` equals `NaN`; `+0` equals `-0`) |
| plain object (record) | the **unordered** set of `key → value` pairs, where `undefined` is not a value |
| array / `ValueList` | the length and the **ordered** element sequence |
| `ValueMap` | the **unordered** set of `(key, value)` entries (canonical values — interned on entry) |
| `ValueSet` | the **unordered** set of elements (canonical values — interned on entry) |
| `InternedString` | the wrapped string |
| class with `[equals]` / registered type | whatever its handlers say |

### Iteration order is not part of the value

Order is *observable* on records, `ValueMap`, and `ValueSet` — you can iterate
them — but it is **not semantic**: it never affects `deepEqual`, `deepHash`, or
which canonical instance you get. On `ValueMap`/`ValueSet` the order is
**content‑determined**: equal collections iterate identically, in an order
driven by the per‑process, seeded hashes of the contents — stable within a
process, different across runs, and never meaningful. Treat it as arbitrary.

Interned records are the deterministic exception: `intern` rewrites plain
objects with **sorted keys**, so canonical records always iterate
alphabetically — a property of the canonical form, not of your input.

If order carries meaning, put it in the value: use an array / `ValueList`
(of `[key, value]` pairs, for a map). An `OrderedMap` / `OrderedSet` with
order‑sensitive equality may be added down the road.

### `undefined` is not a value (in records)

A record is a partial function from string keys to values, and **a key mapped
to `undefined` is the same record as one without the key**. The distinction is
almost always an accident of construction, and the ecosystem's wire formats
cannot even express it:

```ts
deepEqual({ a: undefined }, {});                 // true
intern({ a: undefined }) === intern({});         // true — canonical form drops the key
deepEqual({ ...opts, verbose: maybe }, opts);    // true when `maybe` is undefined
```

Model "present but intentionally empty" with **`null`**, which is a value —
`deepEqual({ a: null }, {})` is `false`. Two places keep `undefined` because
position or intent makes it meaningful there:

- **Arrays** are positional: `[undefined]` has length 1 and does not equal
  `[]`.
- **`ValueMap`** stores it deliberately: `m.set(k, undefined)` is a real
  entry, distinct from absence (`has` tells them apart). With TypeScript, a
  `Map<K, V | undefined>` is a declared intent in a way a record's
  `{ x: opts.x }` never is. (`ValueMap.fromObject` takes a *record* as input,
  so record semantics apply to it: undefined‑valued keys are not carried over.)

---

## Design notes & guarantees

- **Equality is observational substitutability.** If two values are equal they
  are interchangeable everywhere — interning depends on this, so `deepEqual`
  is stricter than a loose "same‑ish" check.
- **Order is not part of the value** for records, `ValueMap`, and `ValueSet`;
  arrays and `ValueList` are ordered. See
  [Iteration order is not part of the value](#iteration-order-is-not-part-of-the-value).
- **Interned values are frozen** — and every `ValueList`/`ValueMap`/`ValueSet`/
  `InternedString` instance is born frozen. Read freely; never mutate.
  Produce new values instead. Registered `{ immutable: true }` types (Temporal,
  your own value types) are pooled *without* freezing: they are immutable by
  contract, and freezing a type you do not own can break it.
- **Only immutable things get value identity.** `intern` pools primitives, plain
  data, the persistent collections, and types declared immutable. The mutable
  built‑ins `Date`, `RegExp`, `Map`, and `Set` are rejected outright rather than
  passed through, so a mutable value can never sit in a pool or silently miss as
  a `HashMap` key.
- **The global pool is weak.** Canonical instances are reclaimed by GC when
  unreferenced; interning will not grow memory without bound. Pool metadata is
  swept incrementally as a bounded tax on pool traffic — cleanup work is
  proportional to use, zero when idle.
- **No cycle handling.** `deepEqual` / `deepHash` / `intern` assume acyclic,
  data‑shaped values. Cyclic graphs are out of scope.
- **Hashing is seeded and flood‑resistant.** The default leaf hash is a
  per‑process **seeded Marvin32** (the algorithm .NET ships for this), drawn
  from `crypto.getRandomValues`, so an attacker cannot precompute inputs that
  collide into one bucket. The 32‑bit hashes are for bucketing, not
  authentication. For untrusted‑input deployments that also worry about seed
  recovery via timing, swap in a keyed PRF with `configureHasher(...)` (e.g.
  SipHash over `getHashSeed()`) — called once at startup, before any hashing.

---

## API reference

### `valsem`

| Symbol | Kind | Summary |
| --- | --- | --- |
| `deepEqual` | function | Structural equality; `.register(type, eq, hash, opts?)` adds a handler pair. |
| `deepHash` | function | Companion structural hash (`equal ⟹ same hash`). |
| `intern` | function | Return the canonical, deduplicated copy of a value (frozen, for values valsem builds). |
| `internHash` | function | Hashing that exploits the intern cache (O(1) for canonical values). |
| `HashMap` | class | Mutable map with structural (interned) keys. |
| `ValueList` / `ValueMap` / `ValueSet` / `InternedString` | class | Persistent collections with canonical instances; `ValueMap`/`ValueSet` implement `ReadonlyMap`/`ReadonlySet`. |
| `produce` / `produceWithPatches` | function | Mutate a draft, get the canonical result — optionally with semantic patches and inverses. Curried form supported. |
| `applyPatches` | function | Apply semantic patches to a value; converges on the same canonical instance as direct production. |
| `nothing` / `isDraft` | symbol / function | Recipe sentinel for "result is `undefined`"; draft detection. |
| `DraftMap` / `DraftSet` / `DraftList` | class | Mutable draft twins of the collections, handed out inside `produce`. |
| `createInternPool` | function | Create a typed weak pool for your own value type. |
| `equals` / `hashCode` / `interned` | symbol | Opt‑in value‑semantics hooks for classes. |
| `configureHasher` / `createMarvin32Hasher` / `getHashSeed` | function | Inspect or replace the seeded leaf hash (e.g. plug in SipHash). |
| `InternPool` / `Hasher` / `RegisterOptions` | type | Pool interface; pluggable leaf‑hash interface; `register` options (`immutable`). |

### `valsem/temporal`

| Symbol | Kind | Summary |
| --- | --- | --- |
| *(side effect)* | import | Registers equality, hashing, and interning for all eight Temporal types. |
| `registerTemporal` | function | The same registration, callable explicitly. Idempotent. |

### `valsem/binding`

The stable surface for binding authors — packages that map valsem's information
model onto another representation (a wire format, a storage layer). Not for
application code.

| Symbol | Kind | Summary |
| --- | --- | --- |
| `defineRecordField` | function | `__proto__`‑safe record‑field definition, for building records from untrusted keys. |
| `hasValueSemantics` | function | Whether a type has registered equality **and** hash handlers. |
| `mutableBuiltinReason` | function | The shared rejection table: why a mutable built‑in is not a value, as error text. |

## License

Apache‑2.0 © Anders Hessellund Jensen
