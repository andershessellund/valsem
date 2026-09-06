# Value collections

## Persistent collections — canonical *instances*

`ValueList`, `ValueMap`, `ValueSet`, and `InternedString` are **immutable**
collections whose *instances* are interned: two with equal contents are the
same reference (`===`), carry a precomputed `[hashCode]`, and can be compared,
deduplicated, and used as keys for free.

```ts
import { ValueList, ValueMap, ValueSet } from 'valsem';

ValueList.of(1, 2, 3) === ValueList.of(1, 2, 3);                 // true
ValueMap.fromObject({ a: 1 }) === ValueMap.fromObject({ a: 1 }); // true
ValueSet.from([1, 2]) === ValueSet.from([2, 1]);                 // true — unordered
```

Mutators are **persistent**: they return the canonical successor, sharing all
untouched structure and allocating nothing when the result already exists. All
three collections are backed by **hash-consed trees** (a CHAMP trie for
`ValueMap`/`ValueSet`, a dense radix vector for `ValueList`): equal content
converges on the very same tree nodes process-wide — however and in whatever
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

### Interop and encapsulation

`ValueMap` **is** a `ReadonlyMap` and `ValueSet` **is** a `ReadonlySet` — pass
them anywhere those are accepted (`ValueSet` includes the ES2025 set-algebra
methods). Their backing collections are private: JavaScript cannot make a
`Map` or `Set` immutable at runtime, so handing one out would let a single
accidental `set()`/`add()` corrupt the shared canonical instance. Take a
mutable copy with `new Map(m)` / `new Set(s)` when you need one.

`ValueList` is a hash-consed radix vector behind the same rule: read with
`get(i)` (a few array hops), iterate in index order, and take the interned
frozen snapshot with `toArray()` — explicitly O(n), weakly memoized, with
`toArray()[i] === get(i)` always. `InternedString` *does* expose its datum —
`value` — because there the platform enforces immutability for real: a string
is a primitive. The rule: the representation is public exactly where the
runtime can actually protect it.

`InternedString` wraps a string and precomputes its hash once, turning
repeated `deepHash`/key lookups on the same string into O(1) reads.

## `HashMap` — a Map with structural keys

`HashMap` interns each key on the way in, so structurally-equal keys — in any
field order — address the same entry. It is the drop-in answer to "I want to
key a Map by an object's value".

```ts
import { HashMap } from 'valsem';

const cache = new HashMap<{ table: string; id: string }, Row>();
cache.set({ table: 'users', id: '1' }, row);
cache.get({ id: '1', table: 'users' }); // → row  (field order irrelevant)

// Avoid the has/get/set dance:
const row2 = cache.getOrCreate({ table: 'users', id: '2' }, loadRow);
```

`HashMap` is a mutable container (like `Map`); only its **keys** get value
semantics. Values are stored as-is — and that asymmetry is the point.
`HashMap` is the *boundary type* where the value world meets the mutable
world: the persistent `Value*` collections intern everything they hold, so
they can only contain values, while `HashMap` stores its values uninterned and
can therefore index **live** objects — DOM nodes, subscriptions, open
connections — by structural key.

### `{ intern: false }` — keys that are new values every call

By default a key is interned on the way in: a canonical key looks up at
native-`Map` speed (~20 ns), and the map holds canonical keys. That is the
right default when keys are your state. It is the wrong one when every key
is a fresh value that nothing else will ever look up — request objects,
query parameters, event payloads — because each novel key is then copied,
frozen, and given a pool entry for nobody's benefit.

```ts
const byRequest = new HashMap<Request, Response>({ intern: false });
byRequest.set({ path: '/users', page: 2 }, res);
byRequest.get({ page: 2, path: '/users' }); // → res — still by content, field order irrelevant
```

In this mode keys are hashed and compared by content without being
canonicalised: a raw-key hit runs ~1.7× faster and a novel-key insert ~2.3×,
and the pool is untouched. Two consequences: keys are stored **as given**,
so mutating one afterwards corrupts the map (the rule of every hash map with
mutable keys), and on canonical keys this mode is *slower* (49 ns against
19), so keep the default for state. `memoize` is built on the same table.

## `HashSet` — a Set with structural members

`HashMap`'s twin: a mutable set whose membership is by content, with the
same two modes. In the default mode an element is interned on the way in
and a native `Set` of canonical references does the rest, so a mutable
visited-set over positions, coordinates, or identifiers just works:

```ts
import { HashSet } from 'valsem';

const seen = new HashSet<{ x: number; y: number }>();
seen.add({ x: 1, y: 2 });
seen.has({ y: 2, x: 1 }); // true — field order irrelevant
HashSet.from(points).size; // duplicates by content collapse
```

`{ intern: false }` matches members by content without canonicalising
them, for elements that are new values every call, stored as given.
`hasCanonical` is the checked identity test, like `HashMap.getCanonical`.
Both classes also take `from(iterable, options?)`.
