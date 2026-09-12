# Getting started

```bash
npm install valsem
```

::: info Runtime requirements
Node ≥ 22 and all current browsers, workers, Deno, and Bun. valsem relies on
`WeakRef`, `FinalizationRegistry` and Web Crypto (`globalThis.crypto`, which
seeds the flood-resistant hasher) — universal for years. Ships as ES modules
with full TypeScript types (TypeScript ≥ 5.6), dependency-free and
tree-shakeable.
:::

## Why

JavaScript objects have **reference identity**. Two objects that look the same
are not equal, cannot be used interchangeably as keys, and cannot be
deduplicated:

```ts
({ x: 1, y: 2 }) === ({ x: 1, y: 2 });        // false
new Map().set({ id: 1 }, 'a').get({ id: 1 }); // undefined — different reference
```

For a lot of code — reactive state, caches, query results, event sourcing,
graph nodes, coordinates, money — what you actually want is **value
semantics**: two things are "the same" when their *contents* are the same. The
usual workarounds are unsatisfying: `JSON.stringify` comparison is slow,
fragile (key order, `undefined`, `bigint`, `NaN`), and allocates; hand-written
`equals` methods drift out of sync with hashing; and building an immutable
"value type" means a lot of boilerplate.

valsem provides value semantics as a small, composable toolkit:

- **`deepEqual` / `deepHash`** — structural equality and a *companion* hash
  that respects it (`deepEqual(a, b)` ⟹ `deepHash(a) === deepHash(b)`).
- **`intern`** — collapse every structurally-equal value to a single, frozen,
  canonical instance, so **value equality becomes `===`** and hashing becomes
  an O(1) cache read.
- **`produce`** — mutate a draft with ordinary syntax, receive the canonical
  result (plus optional semantic patches): the immer ergonomics, ending in
  interned values.
- **Value collections** — `HashMap` / `HashSet` keyed by structure, and the
  persistent `ValueList` / `ValueMap` / `ValueSet`, the insertion-ordered
  `OrderedMap` / `OrderedSet`, `ValueDate`, `InternedString` and `RawArray`,
  whose *instances* are canonical (equal contents ⟹ same reference).
- **Extension points** — the `equals` / `hashCode` / `interned` symbols,
  `deepEqual.register`, and `createInternPool` let any type become a
  first-class value.

## Sixty seconds of valsem

<!--@include: ../../README.md#sixty-seconds-->

Where to go next:

- [Equality, hashing, interning](/guide/values) — the model and its rules.
- [Value collections](/guide/collections) — `ValueMap`/`ValueSet`/`ValueList`
  and the mutable `HashMap`/`HashSet`.
- [produce](/guide/produce) — drafts, patches, and the semantics doctrine.
- [The undo-tree demo](/demo) — what canonical history means in practice.

## Serialization is out of scope

valsem defines what "the same" *means*; it does not define bytes. The split is
deliberate: a wire format that wants identity-preserving decoding
(`decode(encode(x)) === x`) builds on valsem from the outside — decode into
plain data, `intern` the result, and equal payloads collapse to the same
canonical instance no matter when, or from where, they arrived. The
`valsem/binding` subpath is the small, semver-covered contract for authors of
such bindings (see the [API page](/api)).
