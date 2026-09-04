# valsem

**Value semantics for JavaScript** — structural equality, companion hashing,
global interning, and immutable value collections. (Identity‑preserving
serialization lives one package over, in [`samme`](../samme).)

```bash
npm install valsem
```

> Requires a runtime with `WeakRef` and `FinalizationRegistry` (Node 14.6+, and
> all current browsers). Ships as ES modules with full TypeScript types.

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
- **Value collections** — `HashMap` keyed by structure, and the persistent
  `InternArray` / `InternMap` / `InternSet` / `InternString` whose *instances*
  are canonical (equal contents ⟹ same reference).
- **Extension points** — the `equals` / `hashCode` / `interned` symbols,
  `deepEqual.register`, and `createInternPool` let any type become a first‑class
  value.
Everything is dependency‑free and tree‑shakeable. Identity‑preserving
serialization — a JSON‑safe wire where `decode(encode(x)) === x`, plus a
structural `diff`/`apply` — lives in the separate [`samme`](../samme) package,
the wire binding built on valsem.

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

`deepHash` is its **companion**: whenever `deepEqual(a, b)` is `true`,
`deepHash(a) === deepHash(b)` is guaranteed (the converse is not — hashes can
collide). Arrays hash order‑dependently. `deepHash` throws for values it cannot
hash consistently — symbols, functions, class instances with no registered
handler, and the mutable built‑ins below.

### Mutable values are not values

`Date`, `RegExp`, `Map`, and `Set` are **not supported**. valsem gives value
semantics to immutable values only: a canonical instance is shared by every
holder, so one mutation would corrupt all of them *and* invalidate the hash
cached against it. `deepHash`, `intern`, and samme's `encode` all reject them,
naming the immutable replacement:

| Instead of | Use |
| --- | --- |
| `Date` | `Temporal.Instant` — `Temporal.Instant.fromEpochMilliseconds(d.getTime())`, with [`valsem/temporal`](#temporal-valsemtemporal) |
| `RegExp` | a plain `{ source, flags }` record — a regex is behavior, not data |
| `Map` | [`InternMap`](#persistent-collections--canonical-instances) |
| `Set` | [`InternSet`](#persistent-collections--canonical-instances) |
| `TypedArray` / `DataView` / `ArrayBuffer` | a hex or base64 string — bytes are rewritable through *any* view over the same buffer, so no instance can be immutable |

(When TC39's immutable‑`ArrayBuffer` proposal ships, a view over a buffer with
`.immutable === true` is a genuine value, and TypedArray support can return
gated on that check.)

```ts
deepHash(new Date(0));   // throws — names Temporal.Instant
intern({ at: new Date(0) });  // throws
encode(new Set([1]));    // throws — names InternSet.from   (samme)
```

`deepEqual` is the one exception, and only because it cannot throw: it is a
total function, so it reports these as *unequal* rather than raising. If you
need to know why, hash the value.

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

The pool holds values **weakly** (via `WeakRef` + `FinalizationRegistry`), so
canonical instances are garbage‑collected once you stop referencing them —
interning does not leak memory.

```ts
import { internEqual, internHash } from 'valsem';

internEqual(a, { city: 'Aarhus', zip: '8000' }); // true — interns as needed
internHash(a);                                    // cached hash, no traversal
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

`InternArray`, `InternMap`, `InternSet`, and `InternString` are **immutable**
collections whose *instances* are interned: two with equal contents are the same
reference (`===`), carry a precomputed `[hashCode]`, and can be compared,
deduplicated, and used as keys for free.

```ts
import { InternArray, InternMap, InternSet } from 'valsem';

InternArray.of(1, 2, 3) === InternArray.of(1, 2, 3);       // true
InternMap.fromObject({ a: 1 }) === InternMap.fromObject({ a: 1 }); // true
InternSet.from([1, 2]) === InternSet.from([2, 1]);          // true — unordered
```

Mutators are **persistent**: they return the canonical successor and reuse a
pooled instance whenever the result already exists, allocating nothing on a hit.
Hashing is incremental (O(1) per edit for `push`/`pop`/`set`/`delete`), which
makes them ideal for hot state that churns through the same few configurations.

```ts
const v0 = InternArray.empty<number>();
const v1 = v0.push(1).push(2);   // InternArray [1, 2]
const v2 = v1.pop();             // back to the canonical [1] — no allocation
v2 === v0.push(1);               // true

const m1 = InternMap.fromObject({ hp: 3 }).set('sp', 5);
m1.get('sp');                    // 5
[...m1];                         // InternMap *is* a ReadonlyMap — iterate it directly
```

`InternMap` **is** a `ReadonlyMap` and `InternSet` **is** a `ReadonlySet` —
pass them anywhere those are accepted (`InternSet` includes the ES2025
set‑algebra methods). Their backing collections are private: JavaScript cannot
make a `Map` or `Set` immutable at runtime, so handing one out would let a
single accidental `set()`/`add()` corrupt the shared canonical instance. Take a
mutable copy with `new Map(m)` / `new Set(s)` when you need one.

`InternArray` and `InternString` do expose their data — `array` and `value` —
because there the platform enforces immutability for real: the array is deeply
`Object.freeze`‑frozen and the string is a primitive. The rule: the
representation is public exactly where the runtime can actually protect it.

`InternString` wraps a string and precomputes its hash once, turning repeated
`deepHash`/key lookups on the same string into O(1) reads.

---

## Making your own types values

Three well‑known symbols let any class opt into value semantics. Import them and
implement whichever the operation needs:

| Symbol       | Enables                          | Shape                            |
| ------------ | -------------------------------- | -------------------------------- |
| `equals`     | `deepEqual`                      | `[equals](other): boolean`       |
| `hashCode`   | `deepHash`                       | `[hashCode]: number` (or method) |
| `interned`   | fast‑path in `intern`            | `[interned]: true`               |

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

---

## Temporal: `valsem/temporal`

Temporal support is a side-effect import, so consumers who do not use Temporal
pay nothing for it:

```ts
import 'valsem/temporal';
```

That one line registers, for all eight Temporal types, an equality handler, a
companion hash, and an immutability declaration (so `intern` pools them). Wire
codecs for Temporal live in the samme package: `import 'samme/temporal'`, which
loads this module first.

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

## Serialization: the `samme` package

Serialization is deliberately **not** part of valsem. The
[`samme`](../samme) package (Danish: *"the same"*) is the wire binding built on
valsem: `encode` writes a JSON‑safe wire, `decode` returns the canonical
interned value — so a round‑trip yields `===` — and a structural `diff`/`apply`
ships minimal updates for live queries and event streams.

```ts
import { encode, decode } from 'samme';

decode(encode({ id: 7 })) === decode(encode({ id: 7 })); // true
```

valsem defines what "the same" means; samme carries it across the wire.

---

## What exactly is "the value"?

Every operation in valsem — equality, hashing, interning — and every layer of
the samme wire built on it agrees on one definition of what each kind of thing
*is*:

| Kind | Its value is |
| --- | --- |
| primitive | itself (`NaN` equals `NaN`; `+0` equals `-0`) |
| plain object (record) | the **unordered** set of `key → value` pairs, where `undefined` is not a value |
| array / `InternArray` | the length and the **ordered** element sequence |
| `InternMap` | the **unordered** set of `(key, value)` entries (`===` refs) |
| `InternSet` | the **unordered** set of elements (`===` refs) |
| `InternString` | the wrapped string |
| class with `[equals]` / registered type | whatever its handlers say |

### Iteration order is not part of the value

Order is *observable* on records, `InternMap`, and `InternSet` — you can iterate
them — but it is **not semantic**: it never affects `deepEqual`, `deepHash`, or
which canonical instance you get. That has a consequence worth internalizing:
because equal collections collapse to a *single* canonical instance, the order
you observe on an `InternMap` or `InternSet` is whichever structurally‑equal
collection was pooled **first**, and can differ from run to run. Treat it as
arbitrary.

Interned records are the deterministic exception: `intern` rewrites plain
objects with **sorted keys**, so canonical records always iterate
alphabetically — a property of the canonical form, not of your input.

If order carries meaning, put it in the value: use an array / `InternArray`
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
encode({ a: undefined });                        // {} — nothing is written (samme)
diff({ a: 1 }, { a: undefined });                // a record patch deleting 'a' (samme)
deepEqual({ ...opts, verbose: maybe }, opts);    // true when `maybe` is undefined
```

Model "present but intentionally empty" with **`null`**, which is a value —
`deepEqual({ a: null }, {})` is `false`. Two places keep `undefined` because
position or intent makes it meaningful there:

- **Arrays** are positional: `[undefined]` has length 1 and does not equal
  `[]`. Array elements round‑trip through the wire as a tagged envelope.
- **`InternMap`** stores it deliberately: `m.set(k, undefined)` is a real
  entry, distinct from absence (`has` tells them apart). With TypeScript, a
  `Map<K, V | undefined>` is a declared intent in a way a record's
  `{ x: opts.x }` never is. (`InternMap.fromObject` takes a *record* as input,
  so record semantics apply to it: undefined‑valued keys are not carried over.)

---

## Design notes & guarantees

- **Equality is observational substitutability.** If two values are equal they
  are interchangeable everywhere — interning depends on this, so `deepEqual`
  is stricter than a loose "same‑ish" check.
- **Order is not part of the value** for records, `InternMap`, and `InternSet`;
  arrays and `InternArray` are ordered. See
  [Iteration order is not part of the value](#iteration-order-is-not-part-of-the-value).
- **Interned and `Intern*` values are frozen.** Read freely; never mutate.
  Produce new values instead. Registered `{ immutable: true }` types (Temporal,
  your own value types) are pooled *without* freezing: they are immutable by
  contract, and freezing a type you do not own can break it.
- **Only immutable things get value identity.** `intern` pools primitives, plain
  data, the `Intern*` collections, and types declared immutable. The mutable
  built‑ins `Date`, `RegExp`, `Map`, and `Set` are rejected outright rather than
  passed through, so a mutable value can never sit in a pool or silently miss as
  a `HashMap` key.
- **The global pool is weak.** Canonical instances are reclaimed by GC when
  unreferenced; interning will not grow memory without bound.
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
| `internEqual` / `internHash` | function | Equality / hashing that exploit the intern cache. |
| `HashMap` | class | Mutable map with structural (interned) keys. |
| `InternArray` / `InternMap` / `InternSet` / `InternString` | class | Persistent collections with canonical instances; `InternMap`/`InternSet` implement `ReadonlyMap`/`ReadonlySet`. |
| `createInternPool` | function | Create a typed weak pool for your own value type. |
| `equals` / `hashCode` / `interned` | symbol | Opt‑in value‑semantics hooks for classes. |
| `configureHasher` / `createMarvin32Hasher` / `getHashSeed` | function | Inspect or replace the seeded leaf hash (e.g. plug in SipHash). |
| `InternPool` / `Hasher` / `RegisterOptions` | type | Pool interface; pluggable leaf‑hash interface; `register` options (`immutable`). |

### `valsem/temporal`

| Symbol | Kind | Summary |
| --- | --- | --- |
| *(side effect)* | import | Registers equality, hashing, and interning for all eight Temporal types. |
| `registerTemporal` | function | The same registration, callable explicitly. Idempotent. |

### `samme` (separate package)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `encode` / `decode` / `registerCodec` / `diff` / `apply` | function | The wire binding — see the [samme README](../samme/README.md). |

## License

Apache‑2.0 © Anders Hessellund Jensen
