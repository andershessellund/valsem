# API reference

## `valsem`

| Symbol | Kind | Summary |
| --- | --- | --- |
| `deepEqual` | function | Structural equality; `.register(type, eq, hash, opts?)` adds a handler pair. |
| `deepHash` | function | Companion structural hash (`equal ⟹ same hash`). |
| `intern` | function | Return the canonical, deduplicated copy of a value (frozen, for values valsem builds). |
| `internHash` | function | Hashing that exploits the intern cache (O(1) for canonical values). |
| `HashMap` | class | Mutable map with structural (interned) keys. |
| `ValueList` / `ValueMap` / `ValueSet` / `InternedString` | class | Persistent collections with canonical instances; `ValueMap`/`ValueSet` implement `ReadonlyMap`/`ReadonlySet`. |
| `ValueDate` | class | An immutable, canonical timestamp — the value a `Date` stands for. `ValueDate.of(x)` takes what `new Date(x)` takes; `toDate()` returns a fresh mutable `Date`; `valueOf()` is the epoch; `toJSON()` matches `Date`. |
| `produce` / `produceWithPatches` | function | Mutate a draft, get the canonical result — optionally with semantic patches and inverses. Curried form supported. |
| `applyPatches` | function | Apply semantic patches to a value; converges on the same canonical instance as direct production. |
| `nothing` / `isDraft` | symbol / function | Recipe sentinel for "result is `undefined`"; draft detection. |
| `DraftMap` / `DraftSet` / `DraftList` | class | Mutable draft twins of the collections, handed out inside `produce`. |
| `createInternPool` | function | Create a typed weak pool for your own value type. |
| `equals` / `hashCode` / `interned` | symbol | Opt-in value-semantics hooks for classes. |
| `configureHasher` / `createMarvin32Hasher` / `getHashSeed` | function | Inspect or replace the seeded leaf hash (e.g. plug in SipHash). |
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
