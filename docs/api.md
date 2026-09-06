# API reference

## `valsem`

| Symbol | Kind | Summary |
| --- | --- | --- |
| `deepEqual` | function | Structural equality; `.register(type, eq, hash, opts?)` adds a handler pair. Total over admitted values and uncapped: a pair of distinct cyclic raw objects recurses until the engine throws a `RangeError`. |
| `deepHash` | function | Companion structural hash (`equal ⟹ same hash`). |
| `intern` | function | Return the canonical, deduplicated copy of a value (frozen, for values valsem builds, unless `skipFreezing()` was called). |
| `isCanonical(value)` | function | Whether `value` is a primitive or an object valsem canonicalised — the form in which `===` is value equality. The probe behind every canonical short-circuit. |
| `fastEquals(a, b)` | function | `a === b` for canonical values, never a walk. While checks are on, a raw argument throws instead of yielding a silent `false`. |
| `internHash` | function | Hashing that exploits the intern cache (O(1) for canonical values). |
| `HashSet` | class | Mutable set with structural membership — `HashMap`'s twin; members stored as given. |
| `FastMap` / `FastSet` | class | Native `Map`/`Set` for canonical keys, where `===` is value equality: checked while checks are on (a raw key throws instead of silently missing), literally the native class after `skipChecks()`. |
| `HashMap` | class | Mutable map with structural keys, matched by content and stored as given — for keys that are new values every call; nothing is interned or pooled. |
| `ValueList` / `ValueMap` / `ValueSet` / `InternedString` | class | Persistent collections with canonical instances (`ValueList`: O(log n) `insert`/`remove`/`splice`/`slice`/`concat`, `setMany`, and `ValueList.diff(a, b)` in O(c log n)); `ValueMap`/`ValueSet` implement `ReadonlyMap`/`ReadonlySet`. |
| `RawArray` | class | A raw response you take canonical slices from: `slice(a, b)` admits only that range (each element interned once, memoized per slot), so a refetch's unchanged rows come back `===`. Its own value is its identity, so it sits in canonical state as an opaque leaf. |
| `ValueDate` | class | An immutable, canonical timestamp — the value a `Date` stands for. `ValueDate.of(x)` takes what `new Date(x)` takes; `toDate()` returns a fresh mutable `Date`; `valueOf()` is the epoch; `toJSON()` matches `Date`. |
| `produce` / `produceWithPatches` | function | Mutate a draft, get the canonical result — optionally with semantic patches and inverses. Curried form supported. |
| `applyPatches` | function | Apply semantic patches to a value; converges on the same canonical instance as direct production. |
| `nothing` / `isDraft` | symbol / function | Recipe sentinel for "result is `undefined`"; draft detection. |
| `memoize(fn, { maxSize })` | function | A pure function of values, remembered by content: equal argument tuples return the same interned result. LRU over `maxSize` (default 1). Fast as intended — O(1) hits (~40 ns) on canonical arguments — and slow otherwise: raw arguments are hashed and compared on every call. Intern your state first, as everywhere in valsem. |
| `current(draft)` / `original(draft)` | function | Inside a recipe: the canonical value of what the draft holds right now (the draft stays live), and the base it was made from. `Undraft<D>` is their return type — the inverse of `Draft<T>`. Tree-shake with `produce`: a bundle that never calls them carries neither. |
| `DraftMap` / `DraftSet` / `DraftList` | class | Mutable draft twins of the collections, handed out inside `produce`; `get()` returns drafts (`Draft<V>`). |
| `toDraft` | symbol | The draft protocol: implement `[toDraft](parent)` to make a type draftable; `Draft<T>` infers a type's draft from it. Toolkit in `valsem/draft`. |
| `createInternPool` | function | Create a typed weak pool for your own value type. |
| `equals` / `hashCode` / `interned` | symbol | Opt-in value-semantics hooks for classes. |
| `configureHasher` / `createMarvin32Hasher` / `getHashSeed` | function | Inspect or replace the seeded leaf hash (e.g. plug in SipHash). |
| `skipChecks()` / `skipFreezing()` | function | The two one-way switches you own: stop verifying *canonical only* arguments (`fastEquals`, `FastMap`, `FastSet`); stop freezing canonical records and arrays (faster iteration in V8, mutations no longer caught). Neither reads the environment. See the hardening guide. |
| `configureLimits` | function | Decode-boundary guards: `{ maxDepth }` (default 512) caps the nesting `intern`/`deepHash`/`produce` will walk. `deepEqual` stays uncapped (total over admitted values; a plain recursive walk on raw input). |
| `InternPool` / `Hasher` / `RegisterOptions` | type | Pool interface; pluggable leaf-hash interface; `register` options (`immutable`). |

## `valsem/temporal`

| Symbol | Kind | Summary |
| --- | --- | --- |
| *(side effect)* | import | Registers equality, hashing, and interning for all eight Temporal types. |
| `registerTemporal` | function | The same registration, callable explicitly. Idempotent. |

## `valsem/binding`

The stable surface for binding authors — packages that map valsem's
information model onto another representation (a wire format, a storage
layer). Not for application code.

| Symbol | Kind | Summary |
| --- | --- | --- |
| `defineRecordField` | function | `__proto__`-safe record-field definition, for building records from untrusted keys. |
| `hasValueSemantics` | function | Whether a type has registered equality **and** hash handlers. |
| `mutableBuiltinReason` | function | The shared rejection table: why a mutable built-in is not a value, as error text. |

## `valsem/draft`

The toolkit for making your own types draftable — the protocol `produce`
uses for everything but plain objects and arrays, and the route the built-in
collections take. Covered by semver like `valsem/binding`.

| export | description |
| --- | --- |
| `toDraft` | The protocol symbol: implement `[toDraft](parent)` on a class, returning a `DraftState`. Also exported from `valsem`. |
| `createDraftState(fields)` | Build and register a draft state for the running `produce()`; supply your fields, `draft`, `finalize`, and optionally `applyPatch`/`childAt`/`snapshot`/`revoke`. |
| `markChanged(state)` | Record a mutation (bubbles to the root). |
| `assertUnrevoked(state)` | Throw the teaching error once the recipe has ended. |
| `assertAssignable(value, state)` | Reject drafts from another `produce()` call. |
| `createChildDraft(value, state)` | Draft a nested draftable value lazily. |
| `resolve(value, path, recorder)` | Finalize a child (draft or foreign material) to its canonical form, emitting its patches under `path`. |
| `restoreValue(value)` | The inverse-patch value for a child (a draft restores its base). |
| `snapshotOf(value)` | The value as it stands now, nested drafts included, nothing finalized — what your kind's `snapshot` calls on its children so `current()` works through your type. |
| `isDraftable(value)` / `isDraft(value)` / `stateOf(draft)` | Introspection. |
| `emitSeqOps`, `retractSeqPatches`, `seqTailProfile` | The sequence-patch helpers arrays and `ValueList` share, for list-like kinds. |
| `DraftState`, `Patch`, `PatchKinds`, `PatchPath`, `PatchRecorder`, `SeqOp` | Types. Extend `PatchKinds` by declaration merging to add your own patch kinds with exact narrowing. |
