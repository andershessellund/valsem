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

`ValueMap` **is** a `ReadonlyMap` — pass it anywhere one is accepted.
`ValueSet` has the whole `ReadonlySet` read API and the ES2025 set algebra,
with two deliberate differences. The operations take **any iterable of
values** — a `ValueSet`, an array, a native `Set` — as a stream of members
interned on entry, with membership decided by this set's equality and never
by the argument's `has`, so a native `Set` of raw objects is matched by value
in every direction. And they return **`ValueSet`s** — canonical values, so
`a.union(b) === ValueSet.from([...a, ...b])` — where the native methods return
a fresh `Set`. Two `ValueSet`s merge at **node level**: hash-consed tries
share by pointer wherever they agree, so `union`, `intersection`,
`difference`, `symmetricDifference`, `isSubsetOf`, `isSupersetOf` and
`isDisjointFrom` cost in proportion to where the operands differ — O(1) when
they are the same set, at worst linear in the operands, never a per-member
insert. (TypeScript's `ReadonlySet` insists the algebra takes a
`ReadonlySetLike` and returns a native `Set`, so `ValueSet` does not declare
`implements ReadonlySet`; it is a `ReadonlySetLike`, which is what the native
set methods accept as their argument.) Their backing collections are private: JavaScript cannot make a
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

## `OrderedMap` and `OrderedSet` — insertion order as part of the value

`ValueMap` and `ValueSet` iterate in a content-determined order, which is
right for a value whose order means nothing. When the order *is* part of the
meaning — rows as the server sent them, tabs in the order they were opened,
an LRU — `OrderedMap` and `OrderedSet` keep it and make it part of the value:
`OrderedMap.from([['a', 1], ['b', 2]])` and the map built the other way round
are two different values, and equal sequences are one `===` instance however
they were built, like every other valsem collection.

```ts
import { OrderedMap, OrderedSet } from 'valsem';

const rows = OrderedMap.from([['r2', { title: 'b' }], ['r1', { title: 'a' }]]);
rows.get('r1');                    // { title: 'a' }
rows.indexOf('r1');                // 1
rows.at(0);                        // ['r2', { title: 'b' }]
rows.set('r1', { title: 'A' });    // r1 keeps its position — native Map semantics
rows.delete('r2').set('r2', { title: 'b' }); // …and a deleted-then-set key moves to the end
rows.insertAt(1, 'r3', { title: 'c' });      // r2, r3, r1 — what a native Map cannot do
[...rows.keys()];                  // ['r2', 'r1'] — always insertion order

OrderedSet.of('x', 'y').add('x') === OrderedSet.of('x', 'y'); // true — a present member stays put
```

Every operation is O(log n): `get`, `has`, `set`, `delete`, `indexOf`, `at`,
`first`, `last`, `insertAt`. Underneath are three canonical structures — a
`ValueList` of the keys, a `ValueList` of the values, and a trie from key to
value — and the trick that makes `delete` and `indexOf` logarithmic is one
extra pointer per key in the trie: its **anchor**, the first element of the
run of the key list it sits in (or, for a key that starts its run, of the
lowest enclosing run it does not start). Following anchors upward gives the
path to the key; an edit moves only the anchors of the runs it re-chunked. (Immutable.js
keeps order with holes in a list that it compacts now and then — a shape that
depends on delete history, which hash consing cannot allow.) The two lists
are public as `keyList` and `valueList`: two maps with the same keys in the
same order share one key list whatever their values did, so "did the row
order change" is a pointer compare, separately from "did any row change".

`OrderedMap` is a `ReadonlyMap`; `OrderedSet` has the `ReadonlySet` read API.
There is no set algebra on `OrderedSet` — a union has no single natural order —
so take `ValueSet.from(orderedSet)` for that. Inside `produce` they draft as
`DraftOrderedMap` / `DraftOrderedSet` with the same verbs plus `clear()`, and
their patches replay the recipe's operations in order: a delete's inverse is
an insert at the index it had, and a key deleted and set back to the same
value still yields two patches, because it moved.

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
state as an opaque leaf: it is canonical by construction, so `intern` and
`produce` return it as it is.
`slice()` with no arguments admits everything, and `get(i)` reads one row;
there is deliberately no iteration, so the O(n) step is always spelled out.

```ts
import { RawArray } from 'valsem';

const rows = RawArray.from(await (await fetch('/api/rows')).json()); // 100k rows, nothing admitted
const visible = rows.slice(first, first + 100);                       // 100 interns; a canonical array
visible[0] === previousVisible[0];                                     // true when that row's content is unchanged
```

## `HashMap` and `HashSet` — mutable, keyed by value

`HashMap` is a mutable map whose keys are values: equal keys — in any field
order, however the object was built — address the same entry. It is the
drop-in answer to "I want to key a Map by an object's value".

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
HashSet.from(points).size; // duplicates collapse
```

Underneath is a native `Map` (or `Set`) keyed by the canonical key: every
key is **interned on the way in**, on `set` and on every lookup alike. A key
that is already canonical — your state, anything out of `intern`, `produce`
or a collection — costs one cache probe over the native lookup, about 20 ns.
A raw key is interned first: a pool lookup, about 300 ns for a small record,
and a copy into the pool when the key is new. Two consequences: iteration
yields canonical keys, ready for `fastEquals` or a native `Map`; and a key
mutated after insertion changes nothing, because the stored key is the
canonical copy, not your object.

`HashMap` is a mutable container (like `Map`); only its **keys** get value
semantics. Values are stored as-is — and that asymmetry is the point.
`HashMap` is where the value world meets the mutable world: the persistent
`Value*` collections intern everything they hold, so they can only contain
values, while `HashMap` stores its values uninterned and can therefore index
**live** objects — DOM nodes, subscriptions, open connections — by value.

For the last few nanoseconds: once keys are canonical, `===` already *is*
value equality, so a native `Map` keyed by interned values is a map keyed by
value at native speed, with nothing to add. `HashMap` is that map plus the
interning of every key you hand it.

## `memoize` — a pure function, remembered by content

```ts
import { memoize } from 'valsem';

const visible = memoize(
  (todos: ValueList<Todo>, filter: { done: boolean }) =>
    todos.toArray().filter((t) => t.done === filter.done).map((t) => t.text),
  { maxSize: 8 },
);

visible(state.todos, { done: false }); // runs
visible(state.todos, { done: false }); // ~40 ns, and the SAME array instance — a fresh literal is the same value
```

`memoize` caches results keyed on the argument tuple **by value**: two
calls with structurally equal arguments are one call, whatever the
references. It is built on the premise the rest of valsem runs on: you
interned your state when it was constructed, so a hit on canonical
arguments is O(1) at any size, about 40 ns, because the hash is already on
the value and equality is `===`. A small config literal built fresh each
call still hits, matched by value, the case reference-keyed memoizers miss
every time. Hand it raw payloads instead and it is **slow**: a full
hash-and-compare walk per call, easily dearer than recomputing. Memoize
canonical state, not raw data.

Arguments must be values (a function or a mutable built-in is rejected with
the usual teaching error). Results are interned, so equal calls return
`===` results, and a function returning something valsem cannot
canonicalise is rejected rather than shared. `maxSize` is an LRU bound
(default 1, the "same call as last time" memo, as in reselect); the cache
holds its arguments and results strongly, so a size-N cache pins N argument
graphs. `clear()` and `size` live on the memoized function.
