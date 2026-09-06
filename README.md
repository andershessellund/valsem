# valsem

**JavaScript values the way they should have been.**

```bash
npm install valsem
```

**Immutable.** Everything that comes out of `produce`, `intern`, or a
collection is frozen, all the way down. A stray mutation throws instead of
corrupting state.

```ts
import { produce } from 'valsem';

const next = produce(state, (d) => { d.todos[0].done = true; });
next.todos.push(todo); // TypeError: Cannot add property 1, object is not extensible
```

**Ergonomic.** The immer API, verbatim: mutate a draft, get a new value, with
structural sharing. `produceWithPatches`, `applyPatches`, `current`,
`original`, and the curried form are all there.

```ts
const next = produce(state, (d) => {
  d.todos.push({ id: 2, text: 'write docs', done: false });
  d.filter = 'active';
});
```

**Compared by value.** Two values with the same content are equal, and since
every value valsem hands back is canonical, equal means `===`. That is the
property a React app is built around, and it stops paying for what did not
change:

- **No rerender for unchanged data.** Refetch, re-derive, or reload the same
  content and you get the same object, so `React.memo`, `useMemo`, and effect
  dependencies see nothing new.
- **No recomputing selectors.** A memoized selector — valsem's `memoize` or
  reselect's — hits on equal inputs, not just identical references.
- **No refetch for an equal query.** A cache keyed by content (`HashMap` on
  the request parameters) hits when the parameters are equal, however the
  object was built.
- **"Unsaved changes?" is one compare.** `fastEquals(current, saved)`, at any
  size.

```ts
import { intern, memoize, HashMap } from 'valsem';

const users = intern(await (await fetch('/api/users')).json());
users === previousUsers;                       // true whenever the content is unchanged → React.memo hits

const visible = memoize((todos, filter) => todos.filter(matches(filter)));
visible(state.todos, { done: false });         // a fresh filter literal still hits: same value, same result

const cache = new HashMap<Query, Response>();
cache.get({ page: 2, path: '/users' });        // hits the entry stored under { path: '/users', page: 2 }
```

The collections agree with all of this: `ValueMap`, `ValueSet`, `ValueList`
are immutable collections with structural sharing; `HashMap` and `HashSet`
are mutable and keyed by content.

**Extensible.** Your own classes become values with one method — `[equals]`
with a companion `[hashCode]` — or one registration, `deepEqual.register`,
and then compare, hash, intern, and key a map like anything else. Third-party
types work the same way; Temporal ships ready-made behind `valsem/temporal`.
Anything valsem cannot treat as a value — a `Date`, a native `Map`, a class it
does not know — is rejected with an error that names the fix, never silently
compared by reference. See [Extending](#extending).

**Fast.** Here is exactly what is fast, and what is not. Comparing two
canonical values is a pointer check — about 20 ns for a three-key record and
for a three-million-key state alike — and everything built on comparison
inherits that: `fastEquals`, `FastMap` and `FastSet` (native `Map` and `Set`
for canonical keys, checked), `memoize` hits, and hashing, which is a cached
property read.

```ts
import { fastEquals, FastMap } from 'valsem';

fastEquals(current, saved);            // 20 ns at any size
const derived = new FastMap<State, Derived>();
derived.get(state);                    // a native Map lookup — the key is canonical, so === is value equality
```

What is *not* fast is building: every value is hashed and canonicalised when
it is created, so constructing and updating cost more than a plain copy — an
edit to a 10k-item array runs 13–19 µs against immer's ~6, admitting a
1,000-record API response with `intern` costs ~2 ms (5× parsing it; an
unchanged refetch ~0.8 ms), and a
lookup with a raw (uncanonicalised) key walks it. That is the trade: a win for state that
is compared, memoized, keyed, or kept in history more often than it is built,
and a loss for state built once and thrown away. The [benchmarks](#benchmarks)
show both sides.

## Coming from immer

Recipes, the curried form, `produceWithPatches`/`applyPatches`, `nothing`,
`isDraft`, and the mutate-*or*-return rule are the same. The differences:

| | immer | valsem |
| --- | --- | --- |
| Result | a frozen copy | a frozen **canonical** value — equal content ⟹ `===` |
| `Map` / `Set` in state | `enableMapSet()` | `ValueMap` / `ValueSet` (drafted as `DraftMap` / `DraftSet`); native `Map`/`Set` are rejected with the replacement named |
| `Date` in state | allowed | rejected — use `ValueDate.of(date)` (or Temporal via `valsem/temporal`) |
| Class instances in state | drafted if `[immerable]` | rejected unless the class is a value — one method or one registration, see [Extending](#extending) |
| Patches | JSON-Patch-like `{op, path, value}` | semantic ops — `record.set`, `list.splice`, `map.delete`, `set.add`, … — all values canonical |
| `current()` / `original()` | yes | yes — `current()` returns a canonical snapshot, and the draft stays live |
| Async recipes | silently wrong | rejected with an error |

```ts
const next = produce(state, (d) => {
  d.todos.push({ id: 2, text: 'write docs', done: false });
  d.filter = 'active';
});
produce(next, () => {}) === next; // true — no edits, same value (and the same for edits that net out)
```

## Value semantics in sixty seconds

A value is its *content*. Two records with the same keys and values are equal
regardless of key order; a key set to `undefined` is the same as no key at
all; `NaN` equals `NaN`.

```ts
import { deepEqual, intern } from 'valsem';

deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }); // true
deepEqual({ a: 1, x: undefined }, { a: 1 });          // true
deepEqual([NaN], [NaN]);                              // true

// intern() returns THE canonical instance of a value — frozen, deduplicated:
intern({ a: 1, b: [2, 3] }) === intern({ b: [2, 3], a: 1 }); // true
Object.isFrozen(intern({ a: 1 }));                            // true

// …so deepEqual on canonical values is a pointer compare, at any size:
deepEqual(intern(bigTree), intern(otherBigTree)); // O(1) if either is canonical
```

Things that can change after construction are not values, and valsem says so
rather than guessing:

```ts
intern({ at: new Date() });
// TypeError: intern: Date cannot be interned — valsem gives value semantics to
// immutable values only, and a Date can be re-timed with setTime(). Use
// ValueDate.of(date) instead — an immutable, canonical timestamp …

deepEqual(new Date(0), new Date(0)); // false — reference semantics for mutable objects
                                     // (a development-mode warning explains why, once)
```

## Collections

### `HashMap`, `HashSet`, `FastMap`, `FastSet` — mutable, keyed by value

```ts
import { HashMap, FastMap } from 'valsem';

const cache = new HashMap<{ table: string; id: number }, Row>();
cache.set({ table: 'users', id: 1 }, row);
cache.get({ id: 1, table: 'users' }); // row — key order irrelevant

// The idiomatic memoised lookup: the factory runs once per distinct key.
const rows = cache.getOrCreate({ table: 'users', id: 2 }, (key) => loadRow(key));

// Keys that are your state are already canonical — a native Map is a map keyed by value.
const byState = new FastMap<State, Derived>();
byState.set(state, derive(state));
byState.get(produce(state, () => {})); // the same value → the same key, at native-Map speed
```

`HashMap` and `HashSet` match keys by content — hashed and compared
structurally — and store them as given: nothing is copied, frozen, or pooled,
so keys that are fresh values every call (request objects, query params,
coordinates) cost one hash and one compare (~300 ns for a small record). A
key mutated after insertion is no longer found, as in any hash map with
mutable keys. `FastMap` and `FastSet` are the other half: native `Map` and
`Set` for keys that are canonical, where reference equality already is value
equality, so lookups run at native speed (~16 ns). While checks are on a raw
key throws rather than silently missing; after `skipChecks()` the constructor
hands back a plain `Map`.

### `memoize` — a pure function, remembered by content

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

Built on the premise the rest of valsem runs on: you interned your state when
it was constructed, so a hit on canonical arguments is **O(1) at any size**,
about 40 ns, because the hash is already on the value and equality is `===`.
A small config literal built fresh each call still hits, matched by value
(~200 ns for a few keys) — the case reference-keyed memoizers miss every
time. Hand it raw payloads instead and it is **slow**: a full hash-and-compare
walk per call, easily dearer than recomputing. Memoize canonical state, not
raw data. Results are interned: equal calls return `===` results, and a
function returning something valsem cannot canonicalise is rejected rather
than shared. `maxSize` is an LRU bound (default 1, the "same call as last
time" memo).

### `ValueMap`, `ValueSet`, `ValueList` — canonical immutable collections

Every operation returns the canonical instance for the resulting content. Build
a map two different ways and you hold one object:

```ts
import { ValueMap, ValueSet, ValueList } from 'valsem';

const m1 = ValueMap.from([['a', 1], ['b', 2]]);
const m2 = ValueMap.empty<string, number>().set('b', 2).set('a', 1);
m1 === m2;                          // true — different history, same value
m1.set('a', 1) === m1;              // true — a no-op edit is the same value
m1.get('a');                        // 1
[...m1];                            // [['a', 1], ['b', 2]] in a content-determined order

ValueSet.from([1, 2, 3]) === ValueSet.from([3, 2, 1]);            // true
ValueList.of(1, 2, 3) === ValueList.empty<number>().push(1).push(2).push(3); // true
```

Elements are interned on entry, so structurally equal raw objects converge too:

```ts
const s = ValueSet.from([{ x: 1 }]);
s.has({ x: 1 });               // true
s.add({ x: 1 }) === s;         // true — already present, by content
```

Inside `produce`, they are drafted as mutable twins — `DraftMap`, `DraftSet`,
`DraftList` — with the native-looking API:

```ts
const state = intern({ users: ValueMap.from([['anders', { role: 'admin' }]]), tags: ValueSet.from(['a']) });

const next = produce(state, (d) => {
  d.users.get('anders')!.role = 'owner'; // nested values are drafted lazily
  d.users.set('marie', { role: 'admin' });
  d.tags.add('b');
});
next.users.get('marie'); // { role: 'admin' } — canonical, frozen
```

Updates path-copy O(log n) nodes and share the rest — so a one-key change to a
10,000-entry `ValueMap` is a few microseconds, where a drafted native `Map`
copies the whole container.

### `ValueDate` — the value a `Date` stands for

A `Date` can be re-timed, so it is not a value. What it *means* is one number,
and `ValueDate` holds exactly that — canonical, comparable, serialisable the
way a `Date` is:

```ts
import { ValueDate } from 'valsem';

const at = ValueDate.of('2026-09-05T10:00:00Z');  // accepts what new Date(x) accepts
at === ValueDate.of(new Date(at.epochMs));         // true — one instant, one instance
at < ValueDate.of(Date.now());                     // valueOf() is the epoch: comparisons work
at.toDate().setHours(0);                           // a fresh mutable Date; `at` is unchanged
JSON.stringify({ at });                            // {"at":"2026-09-05T10:00:00.000Z"} — as with a Date
```

## Benchmarks

Apple M2 Pro, Node 26, libraries at shipped defaults; details and every
script in [BENCHMARKS.md](BENCHMARKS.md).

**Against immer and mutative** — the update libraries this API replaces:

| | valsem | immer | mutative |
| --- | --- | --- | --- |
| 10k-entry map, one `set` | **3.5 µs** | 474 µs | 400 µs |
| 10k-element list, `set` + `push` | **4.8 µs** | 9.6 µs | 9.0 µs |
| recurrent states (10 held configurations) | **1.5 µs** | 531 µs | 3.3 µs |
| memo hit rate on refetched, equal data | **100 %** | 0 % | 0 % |
| 3-key record, one field | 1.3 µs | **0.8 µs** | **0.6 µs** |
| 10k plain array, one element | 13–19 µs | **~6 µs** | **~6 µs** |

**Against Immutable.js** — the same persistent structures without canonical
instances:

| | valsem | Immutable.js |
| --- | --- | --- |
| equality of two equal 10k-entry maps | **9 ns** | 544 µs |
| equality, differing in one entry | **9 ns** | 100 µs (cold) / 30 ns (hashes cached) |
| iterate 10k entries / elements | **115 / 31 µs** | 150 / 180 µs |
| `get` / `has` | parity | parity |
| one `Map.set` | 4 µs | **0.3 µs** |
| build a 10k-entry map | 14 ms | **1 ms** |

The pattern: a constant-factor cost on every construction and update buys an
asymptotic win on every comparison. It pays off exactly in proportion to how
often values are compared, memoised, or recur — reducer-driven UI state,
caches keyed by structure, undo history, anything that asks "is this the same
as before?" — and it does not pay off for data that is built once and compared
once.

## Extending

Any class becomes a value by implementing `[equals]` and carrying a
`[hashCode]` (a number, precomputed — equal values must hash equal):

```ts
import { equals, hashCode, deepHash } from 'valsem';

class Money {
  readonly [hashCode]: number;
  constructor(readonly amount: number, readonly currency: string) {
    this[hashCode] = deepHash([amount, currency]);
  }
  [equals](o: unknown): boolean {
    return o instanceof Money && o.amount === this.amount && o.currency === this.currency;
  }
}
deepEqual(new Money(5, 'EUR'), new Money(5, 'EUR')); // true
```

Types you do not own are registered instead. Declare `immutable: true` and
`intern` will pool them as canonical `===` instances:

```ts
import { deepEqual, deepHash } from 'valsem';

deepEqual.register(
  Money,
  (a, b) => a.amount === b.amount && a.currency === b.currency,
  (m) => deepHash([m.amount, m.currency]),
  { immutable: true },
);
```

To give your own class canonical instances (equal contents ⟹ the same
object, like the built-in collections), give it a pool:

```ts
import { createInternPool, equals, hashCode, interned } from 'valsem';

const pool = createInternPool<Point>();

class Point {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;
  private constructor(readonly x: number, readonly y: number) {}
  [equals](o: unknown) { return o instanceof Point && o.x === this.x && o.y === this.y; }
  static of(x: number, y: number): Point {
    const p = new Point(x, y);
    (p as any)[hashCode] = deepHash([x, y]);
    return pool.intern(p); // frozen, deduplicated: Point.of(1, 2) === Point.of(1, 2)
  }
}
```

[Temporal](https://tc39.es/proposal-temporal/) values become values with one
import — `PlainDate`, `ZonedDateTime`, `Duration`, all of them:

```ts
import 'valsem/temporal';
deepEqual(Temporal.PlainDate.from('2026-09-05'), Temporal.PlainDate.from('2026-09-05')); // true
```

### Bring your own draftable

`produce` drafts plain objects and arrays itself. Everything else — the
built-in `ValueMap`/`ValueSet`/`ValueList` included — arrives through one
protocol: a class implements `[toDraft](parent)`, returning a draft state
built with the `valsem/draft` toolkit. The state carries the mutable draft the
recipe receives and a `finalize` that turns it back into the canonical value
(emitting patches); `Draft<T>` infers the draft type from it, so
`produce(interval, (d) => { d.hi = 5; })` is fully typed:

```ts
import { toDraft, createDraftState, markChanged, assertUnrevoked, type DraftState } from 'valsem/draft';

class Interval {
  // …a canonical value type, as above…
  [toDraft](parent?: DraftState): IntervalState {
    const state = createDraftState<IntervalState>({
      kind: 'interval', parent, base: this, lo: this.lo, hi: this.hi,
      draft: null!, finalize: (s) => Interval.of(s.lo, s.hi),
    });
    state.draft = new IntervalDraft(state); // getters/setters that call assertUnrevoked + markChanged
    return state;
  }
}
```

The [guide](https://andershessellund.github.io/valsem/guide/extending#bring-your-own-draftable)
has the complete worked example — nested drafting, custom patch kinds with
exact narrowing, `applyPatches` support — which is also a test in the repo.

## Guarantees

- **Immutable.** Everything `produce`, `intern` and the collections return is
  frozen, all the way down — unless you call `skipFreezing()`, which trades
  that enforcement for unfrozen (faster to iterate) canonical arrays; see
  the hardening guide.
- **Canonical.** Equal values are the same object — lineage-free: however a
  value was built, it converges on one instance.
- **Compared by content.** `deepEqual` never throws on a *type* — mutable
  objects simply compare by reference — and on canonical values it is a
  pointer compare.
- **Loud at the boundary.** `Date`, `RegExp`, `Map`, `Set`, `TypedArray`s,
  unknown class instances, and cyclic or absurdly deep input are rejected
  with errors that name the fix. (`deepEqual` on its own never throws: a
  mutable object or unknown instance simply compares by reference.)
- **Hardened for untrusted input.** Hashing is seeded per process (no
  hash-flooding), nesting is depth-capped, `__proto__` keys are handled as
  data. See the [hardening guide](https://andershessellund.github.io/valsem/guide/hardening).
- **No leaks.** Pools hold values weakly; what you stop referencing is
  collected, and the bookkeeping is cleaned up in idle time.

## Gotchas

- **Iteration order of `ValueMap`/`ValueSet` is not part of the value.** Equal
  maps iterate identically, but the order is hash-driven, not insertion. If
  order matters, it is a `ValueList` of pairs.
- **`{ a: undefined }` is `{}`.** Records drop undefined-valued keys; use
  `null` for "present but empty". (`ValueMap` is the opposite: storing
  `undefined` is a real entry.)
- **Drafts do not escape.** A draft used after its `produce` call throws.

## Documentation

The [guide](https://andershessellund.github.io/valsem/) covers each area in
depth — including the [mutable boundary](https://andershessellund.github.io/valsem/guide/boundary),
[what exactly "the value" is](https://andershessellund.github.io/valsem/guide/values),
patches, Temporal's edge cases, and the extension points for wire-format
bindings (`valsem/binding`).

### API at a glance

| | |
| --- | --- |
| `produce`, `produceWithPatches`, `applyPatches`, `nothing`, `isDraft`, `current`, `original` | the immer-shaped API; results and snapshots are canonical |
| `deepEqual`, `intern` | structural equality; the canonical instance of a value |
| `fastEquals`, `isCanonical` | `===` for canonical values, checked; the canonicality probe |
| `HashMap`, `HashSet` | mutable map and set keyed by content, keys stored as given |
| `FastMap`, `FastSet` | native `Map`/`Set` for canonical keys, checked |
| `memoize` | a pure function of values, remembered by content — same arguments, same instance back |
| `ValueMap`, `ValueSet`, `ValueList` | canonical immutable collections (`DraftMap`/`DraftSet`/`DraftList` inside recipes) |
| `ValueDate` | an immutable, canonical timestamp — the value a `Date` stands for |
| `equals`, `hashCode`, `interned`, `deepHash`, `deepEqual.register`, `createInternPool` | making types values |
| `toDraft`, `valsem/draft` | making types draftable — the protocol `produce` uses for everything but plain objects and arrays |
| `configureHasher`, `configureLimits`, `skipChecks`, `skipFreezing` | hardening knobs, and the two switches you own |
| `valsem/temporal` | value semantics for Temporal (side-effect import) |

Runs on Node ≥ 22 and current browsers. `ValueSet`'s set-algebra methods
(`union`, `isSubsetOf`, …) delegate to the ES2025 `Set` methods.

## License

Apache-2.0
