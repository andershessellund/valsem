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
(and the insertion-ordered `OrderedMap`, `OrderedSet`) are immutable
collections with structural sharing whose equal instances are the same
object; `HashMap` and `HashSet` are mutable and keyed by content.

**Extensible.** Your own classes become values with two members — `[equals]`
and a companion `[hashCode]` — or one registration, `deepEqual.register`,
and then compare, hash, intern, and key a map like anything else. Third-party
types work the same way; Temporal ships ready-made behind `valsem/temporal`.
Anything valsem cannot treat as a value — a `Date`, a native `Map`, a class it
does not know — is rejected with an error that names the fix, never silently
compared by reference. See [Extending](#extending).

**Fast.** Here is exactly what is fast, and what is not. Comparing two
canonical values is a pointer check — tens of nanoseconds for a three-key
record and for a three-million-key state alike — and everything built on
comparison inherits that: `fastEquals`, `HashMap` and `HashSet` lookups on
canonical keys, `memoize` hits, and hashing, which is a cached property read.

```ts
import { fastEquals, HashMap } from 'valsem';

fastEquals(current, saved);            // a pointer compare, at any size
const derived = new HashMap<State, Derived>();
derived.get(state);                    // a native Map lookup plus one probe — the key is canonical, so === is value equality
```

What is *not* fast is building: every value is hashed and canonicalised when
it is created, so constructing and updating cost more than a plain copy. An
edit to a large plain array costs a few times what immer charges, admitting
a large API response costs a few times parsing it, and a lookup with a raw
(uncanonicalised) key walks it. That is the trade: a win for state that is
compared, memoized, keyed, or kept in history more often than it is built,
and a loss for state built once and thrown away.
[BENCHMARKS.md](BENCHMARKS.md) shows both sides, losses first.

## Coming from immer

Recipes, the curried form, `produceWithPatches`/`applyPatches`, `nothing`,
`isDraft`, and the mutate-*or*-return rule are the same. The differences:

| | immer | valsem |
| --- | --- | --- |
| Result | a frozen copy | a frozen **canonical** value — equal content ⟹ `===` |
| `Map` / `Set` in state | `enableMapSet()` | `ValueMap` / `ValueSet` (drafted as `DraftMap` / `DraftSet`); native `Map`/`Set` are rejected with the replacement named |
| `Date` in state | allowed | rejected — use `ValueDate.of(date)` (or Temporal via `valsem/temporal`) |
| Class instances in state | drafted if `[immerable]` | rejected unless the class is a value — `[equals]` + `[hashCode]`, or one registration, see [Extending](#extending); a value is an opaque leaf in a recipe (`Draft<ValueDate>` is `ValueDate`) unless it implements `[toDraft]` — give a registered class at least one method so the types can tell |
| Patches | JSON-Patch-like `{op, path, value}` | semantic ops — `record.set`, `list.splice`, `map.delete`, `set.add`, … — all values canonical |
| `current()` / `original()` | yes | yes — `current()` returns a canonical snapshot, and the draft stays live |
| `createDraft()` / `finishDraft()` | a draft with its own lifetime | `draft(value)` inside a recipe — a detached draft that resolves where you attach it, and is revoked with the recipe like every other draft |
| Async recipes | silently wrong | rejected with an error |

```ts
const next = produce(state, (d) => {
  d.todos.push({ id: 2, text: 'write docs', done: false });
  d.filter = 'active';
});
produce(next, () => {}) === next; // true — no edits, same value (and the same for edits that net out)
```

## Value semantics in sixty seconds

<!-- #region sixty-seconds -->
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

`produce` gives you mutable syntax over those values, and its result is
canonical too — edits that net out converge back to the very same base
object:

```ts
import { produce, ValueList } from 'valsem';

const state = intern({ count: 1, todos: ValueList.of('a') });
const next = produce(state, (draft) => {
  draft.count++;
  draft.todos.push('b');
});
next === intern({ count: 2, todos: ValueList.of('a', 'b') }); // true

produce(state, (d) => { d.count++; d.count--; }) === state;   // true — literally the base
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
<!-- #endregion sixty-seconds -->

## Collections

Every operation on a value collection returns the canonical instance for
the resulting content, so two collections with equal content are one
object, however they were built:

```ts
import { ValueMap, ValueSet, ValueList, OrderedMap, HashMap } from 'valsem';

const m1 = ValueMap.from([['a', 1], ['b', 2]]);
const m2 = ValueMap.empty<string, number>().set('b', 2).set('a', 1);
m1 === m2;                                                   // true — different history, same value
m1.set('a', 1) === m1;                                       // true — a no-op edit is the same value
ValueSet.from([1, 2, 3]) === ValueSet.from([3, 2, 1]);       // true — order is not part of a set
OrderedMap.from([['a', 1], ['b', 2]]) === OrderedMap.from([['b', 2], ['a', 1]]); // false — here it is
ValueList.of(1, 2, 3) === ValueList.empty<number>().push(1).push(2).push(3);      // true

const cache = new HashMap<{ table: string; id: number }, Row>();
cache.set({ table: 'users', id: 1 }, row);
cache.get({ id: 1, table: 'users' });                        // row — mutable map, keyed by value
```

Inside `produce` the collections draft as mutable twins (`DraftMap`,
`DraftSet`, `DraftList`, …) with the native-looking API, and an update
path-copies O(log n) nodes and shares the rest. The
[collections guide](https://andershessellund.github.io/valsem/guide/collections)
covers each of them: the persistent `ValueMap`/`ValueSet`/`ValueList`, the
insertion-ordered `OrderedMap`/`OrderedSet`, the mutable `HashMap`/`HashSet`,
`memoize`, and the two tools for the ends of the scale, `InternedString` and
`RawArray`.

## Benchmarks

`pnpm bench` runs every suite on Node and on Bun and renders
[BENCHMARKS.md](BENCHMARKS.md), with a description of exactly what each row
measures: `produce` against immer and mutative, the collections against
Immutable.js, `deepEqual` against fast-deep-equal, the cost of admitting an
API response, and what frozen arrays cost in each engine. The short version:
a constant-factor cost on every construction and update buys an asymptotic
win on every comparison. It pays off in proportion to how often values are
compared, memoised, or recur, and not for data built once and compared once.

## Extending

Any class becomes a value by implementing `[equals]` and carrying a
`[hashCode]` (a number, precomputed — equal values must hash equal):

```ts
import { deepEqual, equals, hashCode, deepHash, intern, HashMap } from 'valsem';

class Money {
  readonly [hashCode]: number;
  constructor(readonly amount: number, readonly currency: string) {
    this[hashCode] = deepHash([amount, currency]);
  }
  [equals](o: unknown): boolean {
    return o instanceof Money && o.amount === this.amount && o.currency === this.currency;
  }
}
deepEqual(new Money(5, 'EUR'), new Money(5, 'EUR'));        // true
intern(new Money(5, 'EUR')) === intern(new Money(5, 'EUR')); // true — pooled, one instance
new HashMap().set(new Money(5, 'EUR'), 'x').get(new Money(5, 'EUR')); // 'x' — keyed by content
```

The hash is the declaration that makes it a value: carrying one says the
instance never changes, and with that promise valsem pools it, keys by it,
and stores it in state. The
[extending guide](https://andershessellund.github.io/valsem/guide/extending)
has the rest: the comparable-only tier, registering types you do not own,
canonical instances by construction with `createInternPool`, Temporal via
`import 'valsem/temporal'`, and
[bringing your own draftable](https://andershessellund.github.io/valsem/guide/extending#bring-your-own-draftable)
so `produce` can edit your type in place, with patches.

## Guarantees

- **Immutable.** Everything `produce`, `intern` and the collections return is
  frozen, all the way down — unless you call `skipFreezing()`, which trades
  that enforcement for unfrozen (faster to iterate) canonical arrays; see
  the [hardening guide](https://andershessellund.github.io/valsem/guide/hardening).
- **Canonical.** Equal values are the same object — lineage-free: however a
  value was built, it converges on one instance.
- **Compared by content.** `deepEqual` never throws on a *type* — mutable
  objects simply compare by reference — and on canonical values it is a
  pointer compare.
- **Loud at the boundary.** `Date`, `RegExp`, `Map`, `Set`, `TypedArray`s,
  unknown class instances, and cyclic or absurdly deep input are rejected
  with errors that name the fix.
- **Hardened for untrusted input.** Hashing is seeded per process (no
  hash-flooding), nesting is depth-capped, `__proto__` keys are handled as
  data.
- **No leaks.** Pools hold values weakly; what you stop referencing is
  collected, and the bookkeeping is cleaned up in idle time.

## Gotchas

- **Iteration order of `ValueMap`/`ValueSet` is not part of the value.** Equal
  maps iterate identically, but the order is hash-driven, not insertion. If
  order matters, use `OrderedMap`/`OrderedSet`, where it is.
- **`{ a: undefined }` is `{}`.** Records drop undefined-valued keys; use
  `null` for "present but empty". (`ValueMap` is the opposite: storing
  `undefined` is a real entry.)
- **Drafts do not escape.** A draft used after its `produce` call throws.

## Documentation

The [guide](https://andershessellund.github.io/valsem/) covers each area in
depth: [getting started](https://andershessellund.github.io/valsem/guide/getting-started),
[what exactly "the value" is](https://andershessellund.github.io/valsem/guide/values),
[the collections](https://andershessellund.github.io/valsem/guide/collections),
[`produce` and patches](https://andershessellund.github.io/valsem/guide/produce),
[the mutable boundary](https://andershessellund.github.io/valsem/guide/boundary),
[extending](https://andershessellund.github.io/valsem/guide/extending),
[hardening](https://andershessellund.github.io/valsem/guide/hardening), and the
[API reference](https://andershessellund.github.io/valsem/api). For working
on the library itself: [DESIGN.md](DESIGN.md) describes how it is built,
[DECISIONS.md](DECISIONS.md) why, and [BENCHMARKS.md](BENCHMARKS.md) what
it costs.

### API at a glance

| | |
| --- | --- |
| `produce`, `produceWithPatches`, `applyPatches`, `nothing`, `isDraft`, `draft`, `current`, `original` | the immer-shaped API; results and snapshots are canonical; `draft()` detaches a second root for material brought in from elsewhere |
| `deepEqual`, `intern` | structural equality; the canonical instance of a value |
| `fastEquals`, `isCanonical` | `===` for canonical values, checked; the canonicality probe |
| `HashMap`, `HashSet` | mutable map and set keyed by value; native `Map`/`Set` behind `intern` |
| `memoize` | a pure function of values, remembered by content — same arguments, same instance back |
| `ValueMap`, `ValueSet`, `ValueList` | canonical immutable collections (`DraftMap`/`DraftSet`/`DraftList` inside recipes) |
| `OrderedMap`, `OrderedSet` | the same, insertion-ordered — order is part of the value; `indexOf`, `at`, `insertAt` in O(log n) (`DraftOrderedMap`/`DraftOrderedSet` inside recipes) |
| `ValueDate` | an immutable, canonical timestamp — the value a `Date` stands for |
| `InternedString`, `RawArray` | a string with its hash paid once; a large response admitted slice by slice |
| `equals`, `hashCode`, `interned`, `deepHash`, `deepEqual.register`, `createInternPool` | making types values |
| `toDraft`, `valsem/draft` | making types draftable — the protocol `produce` uses for everything but plain objects and arrays |
| `configureHasher`, `configureLimits`, `skipChecks`, `skipFreezing` | hardening knobs, and the two switches you own |
| `valsem/temporal` | value semantics for Temporal (side-effect import) |
| `valsem/binding` | the two helpers a wire or storage binding needs; not for application code |

Runs on Node ≥ 22 and current browsers, with TypeScript ≥ 5.6 for the types.

## License

Apache-2.0
