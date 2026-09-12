# The mutable boundary

## Mutable values are not values

`Date`, `RegExp`, `Map`, and `Set` are **not supported**. valsem gives value
semantics to immutable values only: a canonical instance is shared by every
holder, so one mutation would corrupt all of them *and* invalidate the hash
cached against it. `deepHash` and `intern` both reject them, naming the
immutable replacement:

| Instead of | Use |
| --- | --- |
| `Date` | `ValueDate.of(d)` — an immutable, canonical timestamp with `toDate()` for a mutable copy; or `Temporal.Instant` with [`valsem/temporal`](/guide/extending#temporal-valsem-temporal) |
| `RegExp` | a plain `{ source, flags }` record — a regex is behavior, not data |
| `Map` | [`ValueMap`](/guide/collections) |
| `Set` | [`ValueSet`](/guide/collections) |
| `TypedArray` / `DataView` / `ArrayBuffer` | a hex or base64 string — bytes are rewritable through *any* view over the same buffer, so no instance can be immutable |

(When TC39's immutable-`ArrayBuffer` proposal ships, a view over a buffer with
`.immutable === true` is a genuine value, and TypedArray support can return
gated on that check.)

```ts
deepHash(new Date(0));        // throws — names ValueDate.of (and Temporal.Instant)
intern({ at: new Date(0) });  // throws
intern(new Set([1]));         // throws — names ValueSet.from
```

### `ValueDate` — the value a `Date` stands for

A `Date` can be re-timed, so it is not a value. What it *means* is one
number, and `ValueDate` holds exactly that — canonical, comparable, and
serialisable the way a `Date` is:

```ts
import { ValueDate } from 'valsem';

const at = ValueDate.of('2026-09-05T10:00:00Z');  // accepts what new Date(x) accepts
at === ValueDate.of(new Date(at.epochMs));         // true — one instant, one instance
at < ValueDate.of(Date.now());                     // valueOf() is the epoch: comparisons work
at.toDate().setHours(0);                           // a fresh mutable Date; `at` is unchanged
JSON.stringify({ at });                            // {"at":"2026-09-05T10:00:00.000Z"} — as with a Date
```

Inside `produce` a `ValueDate` is an opaque leaf: assign a new one into its
slot (`d.at = ValueDate.of(later)`) rather than editing it.

`Object.freeze` is not a way around this. It does not reach the internal slots
of a `Date` or a `Map`; on a `RegExp` it makes `lastIndex` read-only, which
makes `.exec()` throw; and on a non-empty `TypedArray` it throws outright —
whose bytes are rewritable through any other view over the same buffer anyway.

## deepEqual is total — deliberately

`deepEqual` is the one operation that never throws on a *type*, and not as a
concession. (It is total over admitted values; on raw, never-admitted input it
is an ordinary recursive walk, so cyclic or engine-stack-deep input overflows
the stack — see the hardening guide.)
For mutable objects, **reference equality is the correct answer**: equality
means observational substitutability, and two distinct `Date`s are not
substitutable — one `setTime()` later they observably diverge. Content
comparison over independently-mutable objects asserts a sameness their
mutability falsifies, so the honest report is *unequal*. Totality also lets
`deepEqual` sit safely in positions that must not throw — memo comparators,
dedup gates — while the throwing happens where it belongs: at the boundaries
that admit data into value-land (`deepHash`, `intern`, the collections,
`produce`), each error naming the immutable replacement. If you need to know
*why* two things are unequal, hash one.

Because the reference answer is correct *and* famously surprising, comparing
two **distinct instances of the same mutable built-in** logs a one-time
development warning naming the replacement (`new Set()` vs `new Set()` is the
classic first encounter). Production builds stay silent; nothing ever throws.

## The contained escape hatch

If your application truly wants, say, Date-by-time equality, register an
**equality alone**:

```ts
deepEqual.register(Date, (a, b) => a.getTime() === b.getTime());
```

That makes `deepEqual` answer by content for Dates — and that is all an
equality claims, so it is honest for a mutable type. What it does not do is
make `Date` a value: `deepHash`, `intern`, the collections, `produce`, and
`HashMap` keys still refuse it. A hash would declare immutability, and a hash
taken from a mutable object goes stale the moment it mutates, so structures
keyed by it would silently miss; `register` therefore refuses a hash for the
mutable built-ins outright. That silent miss is precisely why these types are
not values by default.

A class instance with neither an `[equals]` method nor a registered handler
falls back to **reference semantics** (`deepEqual` is `Object.is`); `deepHash`
and `intern` throw, because there is no safe, content-based hash to offer. See
[Making your own types values](/guide/extending).
