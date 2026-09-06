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
`ValueMap`/`ValueSet`, a content-chunked tree for `ValueList`): equal content
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

`ValueList` is a hash-consed, content-chunked tree behind the same rule:
read with `get(i)` (a size-table walk; sequential reads stay in one leaf),
iterate in index order, and take the interned frozen snapshot with
`toArray()` — explicitly O(n), weakly memoized, with `toArray()[i] === get(i)`
always. Because a chunk boundary is a property of the elements beside it,
the tree's shape is a function of the content alone, so `insert`, `remove`,
`splice`, `slice` and `concat` are O(log n) expected (they disturb only the
chunks around the edit), `setMany` applies a batch of point edits in one
pass, and `ValueList.diff(a, b)` returns the changed regions between *any*
two lists — a refetched one included — in O(c log n) expected, by skipping
every node they share. The bounds are expected on the seeded hash, with no
amortised rebuild anywhere. `InternedString` *does* expose its datum —
`value` — because there the platform enforces immutability for real: a string
is a primitive. The rule: the representation is public exactly where the
runtime can actually protect it.

## Things you are unlikely to need — but if you do

Two tools for the ends of the scale, each solving one problem the core
deliberately does not.

`InternedString` is the large-string tool. A string is hashed by walking it
(~1 ns per character), and valsem hashes a string value every time the
record holding it is hashed from raw — at the boundary, and on raw-key
lookups. Wrap a long text field once, at the boundary, with
`InternedString.for(text)`: the hash is paid once per distinct text for the
life of the value, equal texts are one `===` instance, and every later hash
of the record reaches it through a cached lookup. It stringifies as the text
(`toJSON`), so a state holding one serialises exactly as one holding
strings; the round trip back is `InternedString.for` at the boundary. The
price is an object where a primitive was: reads go through `.value`, and
`typeof` says `'object'`. Ids, names and short strings do not need it —
hashing them costs less than the wrapper.

`RawArray` is the large-response tool. Admitting a response costs ~1.8 µs
per 10-field record, paid for every record whether or not anything looks
at it, and a 100k-row response is admitted to show 100 rows. A `RawArray`
holds the response as received and admits on demand: `slice(a, b)` returns
the canonical array of that range, each element interned once and memoized
per slot, so the visible window costs 100 interns, the same row is the same
object across slices, and a refetch's unchanged rows land on the same pool
instances and come back `===`. It is not a value of its content — two views
over equal JSON are two values, by identity — so it sits inside canonical
state as an opaque leaf that `intern` and `produce` pass through.
`slice()` with no arguments admits everything, and `get(i)` reads one row;
there is deliberately no iteration, so the O(n) step is always spelled out.

```ts
import { RawArray } from 'valsem';

const rows = RawArray.from(await (await fetch('/api/rows')).json()); // 100k rows, nothing admitted
const visible = rows.slice(first, first + 100);                       // 100 interns; a canonical array
visible[0] === previousVisible[0];                                     // true when that row's content is unchanged
```

## `HashMap` and `HashSet` — mutable, keyed by content

`HashMap` matches keys by content, so structurally-equal keys — in any field
order — address the same entry. It is the drop-in answer to "I want to key a
Map by an object's value".

```ts
import { HashMap, HashSet } from 'valsem';

const cache = new HashMap<{ table: string; id: string }, Row>();
cache.set({ table: 'users', id: '1' }, row);
cache.get({ id: '1', table: 'users' }); // → row  (field order irrelevant)

// Avoid the has/get/set dance:
const row2 = cache.getOrCreate({ table: 'users', id: '2' }, loadRow);

const seen = new HashSet<{ x: number; y: number }>();
seen.add({ x: 1, y: 2 });
seen.has({ y: 2, x: 1 });  // true
HashSet.from(points).size; // duplicates by content collapse
```

Keys are hashed and compared structurally and **stored as given**: nothing is
copied, frozen, or pooled. That makes these the right containers for keys
that are new values every call — request objects, query params, coordinates
— at one hash and one compare per lookup (~300 ns for a small record), with
the pool untouched. Two consequences: iteration yields your own key objects,
and a key mutated after insertion is no longer found (the rule of every hash
map with mutable keys).

`HashMap` is a mutable container (like `Map`); only its **keys** get value
semantics. Values are stored as-is — and that asymmetry is the point.
`HashMap` is the *boundary type* where the value world meets the mutable
world: the persistent `Value*` collections intern everything they hold, so
they can only contain values, while `HashMap` stores its values uninterned and
can therefore index **live** objects — DOM nodes, subscriptions, open
connections — by structural key.

## `FastMap` and `FastSet` — native, for canonical keys

Once keys are canonical — anything out of `intern`, `produce`, or a
collection — `===` already *is* value equality, so a native `Map` keyed by
reference is a map keyed by value, at native speed, with nothing to add.
`FastMap` and `FastSet` are exactly that: subclasses of `Map` and `Set` that
verify every key is canonical while checks are on (a raw key would silently
miss, so it throws instead), and after `skipChecks()` return the plain native
class from their constructor.

```ts
import { FastMap } from 'valsem';

const derived = new FastMap<State, Derived>();
derived.set(state, derive(state));
derived.get(produce(state, () => {})); // same value, same key — ~16 ns
derived.get({ ...state });              // TypeError: FastMap takes canonical keys only …
```

The rule for choosing: keys that are your state take `FastMap`/`FastSet`;
keys that are fresh values every call take `HashMap`/`HashSet`. Both pairs
take an iterable (`HashMap.from`, and the native constructors).
