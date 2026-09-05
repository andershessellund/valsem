# Equality, hashing, interning

## Structural equality and hashing

The two primitives everything else is built on:

```ts
import { deepEqual, deepHash } from 'valsem';

deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 }); // true  — key order is irrelevant
deepEqual([1, 2, 3], [1, 2, 3]);           // true
deepEqual([1, 2], [2, 1]);                 // false — array order is significant

deepHash({ x: 1, y: 2 }) === deepHash({ y: 2, x: 1 }); // true
```

`deepEqual` dispatches on the runtime kind of its arguments and handles
primitives (including `NaN` and `±0`), plain objects (key-order-independent),
and arrays (order-sensitive). Plain-object comparison is recursive.

`deepEqual` also **consults canonicality**: because equal content collapses to
one canonical instance, two *distinct* canonical values compare unequal in
O(1) — no walk — and comparisons of mixed trees terminate at every canonical
boundary. Interning your data makes `deepEqual` fast retroactively.

`deepHash` is its **companion**: whenever `deepEqual(a, b)` is `true`,
`deepHash(a) === deepHash(b)` is guaranteed (the converse is not — hashes can
collide). Arrays hash order-dependently. `deepHash` throws for values it
cannot hash consistently — symbols, functions, class instances with no
registered handler, and the [mutable built-ins](/guide/boundary).

## Interning: value identity via `===`

`deepEqual` answers "are these equal?" one comparison at a time. **Interning**
goes further: it replaces every structurally-equal value with one shared
canonical instance, so from then on ordinary `===` *is* value equality.

```ts
import { intern } from 'valsem';

const a = intern({ city: 'Aarhus', zip: '8000' });
const b = intern({ zip: '8000', city: 'Aarhus' });

a === b; // true — same frozen canonical object
```

`intern` walks the value bottom-up: it interns children first, then looks the
whole value up in a global pool keyed by `deepHash`. On a hit you get the
existing instance back and nothing is allocated; on a miss the value is
**deep-frozen**, its hash is cached, and it becomes the canonical instance.
That yields three properties at once:

1. **Value equality is `===`** — no per-comparison traversal.
2. **Hashing is O(1)** — the hash is cached on the canonical instance.
3. **Sharing is automatic** — identical subtrees are stored once.

The pool holds values **weakly** (via `WeakRef`), so canonical instances are
garbage-collected once you stop referencing them — interning does not leak
memory. Pool bookkeeping is reclaimed by an incremental, traffic-driven
sweeper (plus a single GC-epoch sentinel): a bounded constant tax on pool
operations, with no per-entry finalizers, no monolithic cleanup passes, and no
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
[`createInternPool`](/guide/extending#interned-value-types-with-createinternpool))
or by registering with `{ immutable: true }`, which is how `valsem/temporal`
makes Temporal values canonical. Everything else passes through **untouched**.
`Date`, `RegExp`, `Map`, and `Set` [throw](/guide/boundary) rather than
passing through.

::: warning Interned values are frozen
Treat interning as the boundary into immutable, shareable data. If you need to
"change" an interned value, produce a new one — [`produce`](/guide/produce)
and the value collections make this cheap.
:::

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
them — but it is **not semantic**: it never affects `deepEqual`, `deepHash`,
or which canonical instance you get. On `ValueMap`/`ValueSet` the order is
**content-determined**: equal collections iterate identically, in an order
driven by the per-process, seeded hashes of the contents — stable within a
process, different across runs, and never meaningful. Treat it as arbitrary.

Interned records are the deterministic exception: `intern` rewrites plain
objects with **sorted keys**, so canonical records always iterate
alphabetically — a property of the canonical form, not of your input.

If order carries meaning, put it in the value: use an array / `ValueList` (of
`[key, value]` pairs, for a map).

### `undefined` is not a value (in records)

A record is a partial function from string keys to values, and **a key mapped
to `undefined` is the same record as one without the key**. The distinction is
almost always an accident of construction, and the ecosystem's wire formats
cannot even express it:

```ts
deepEqual({ a: undefined }, {});              // true
intern({ a: undefined }) === intern({});      // true — canonical form drops the key
deepEqual({ ...opts, verbose: maybe }, opts); // true when `maybe` is undefined
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
  so record semantics apply to it: undefined-valued keys are not carried
  over.)

## Design laws

- **Equality is observational substitutability.** If two values are equal they
  are interchangeable everywhere — interning depends on this, so `deepEqual`
  is stricter than a loose "same-ish" check.
- **Only immutable things get value identity** — see
  [the mutable boundary](/guide/boundary).
- **Order is never semantic** for records, `ValueMap`, and `ValueSet`; arrays
  and `ValueList` are ordered.
- **No cycle handling.** `deepEqual` / `deepHash` / `intern` assume acyclic,
  data-shaped values; deeply nested or cyclic input is rejected at the
  admission boundary (see [Hardening](/guide/hardening)).
