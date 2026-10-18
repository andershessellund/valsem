# Making your own types values

Three well-known symbols let any class opt into value semantics. Import them
and implement whichever tier you mean:

| Symbol       | Makes the class                                                 | Shape                                       |
| ------------ | --------------------------------------------------------------- | ------------------------------------------- |
| `equals`     | **comparable** — `deepEqual` answers by content                 | `[equals](other): boolean`                  |
| `hash`       | **a value** — hashable, internable, usable wherever a value goes | `[hash](hasher): number` — a method that hashes the content through the hasher it is given |
| `interned`   | an **auto-interning type** — every instance canonical by construction | `[interned]: true`                    |

```ts
import { deepEqual, equals, hash, deepHash, intern, type Hasher } from 'valsem';

class Money {
  constructor(readonly amount: number, readonly currency: string) {}

  [equals](other: unknown): boolean {
    return other instanceof Money
      && other.amount === this.amount
      && other.currency === this.currency;
  }

  [hash](hasher: Hasher): number {
    return deepHash([this.amount, this.currency], hasher);
  }
}

deepEqual(new Money(5, 'DKK'), new Money(5, 'DKK'));        // true
intern(new Money(5, 'DKK')) === intern(new Money(5, 'DKK')); // true — one pooled instance
```

The two tiers are a statement about mutability. An equality alone claims
nothing beyond "here is how to compare two of these right now", which is
honest even for a mutable object. A hash is only useful if it never changes,
so **`[hash]` declares that instances are immutable after construction**
— and with that declaration the class is a value everywhere: `deepHash`
hashes it, `intern` pools equal instances into one canonical `===` instance
(unfrozen — immutability is the class's own contract), and it can be a
`HashMap` key, a collection member, a `memoize` argument, or state inside
`produce`. Only claim it if it is true: a pooled instance is shared by every
holder, so one mutation corrupts all of them and invalidates the pooled hash.

Implement `equals` and `hash` **together** — the companion invariant
(`equals ⟹ same hash`, under every hasher) is what makes hashing and
interning correct. A class with `[equals]` but no `[hash]` compares by
content and is refused everywhere else — `deepHash`, `intern`, the
collections, `HashMap` keys, `memoize`, `produce` — with an error naming the
missing hash. Nothing is passed through silently: a `HashMap` keyed by such
an object would miss every equal lookup.

`[hash]` takes the hasher so that one method serves every hasher. Hash the
parts that are values with `deepHash(part, hasher)`, the leaves with
`hasher.string` and `hasher.number`, and combine with `mix`; never read the
active hasher or a hash you computed earlier. Called with the **active**
hasher — the process's one, seeded per process or installed once by
`configureHasher`, the hasher valsem interns with — it gives the hash every
pool and collection buckets by; valsem computes that once, when it interns
an instance, and keeps it. Called with a
hasher of the
caller's, through `deepHash(value, hasher)`, it gives the hash under that
one: a `createMarvin32Hasher(k0, k1)` built on constants hashes the same
value the same in every process, which is what a reproducible fingerprint,
or a seeded choice that must replay, needs. Such a hasher is not
flood-resistant, since its key is no secret — never bucket untrusted data by
it, and never install it as the active hasher of a process that ingests
any; see [hardening](/guide/hardening#a-hasher-of-your-own).

**Coming from a precomputed `[hashCode]`.** Before 0.2 a class declared
itself a value by carrying a `[hashCode]` number it computed itself. That
is refused now, with the reason: a number computed any way at all is one
the hasher valsem interns with never saw, so a seeded hash, or a SipHash
plugged in with `configureHasher` for a deployment that ingests untrusted
data, did not cover the class — and nothing said so. Replace it with
`[hash](hasher) { return deepHash([…the content…], hasher); }` and drop
the field: the hash valsem computes is its own to cache, and the symbol
it caches it under is no longer exported.

For third-party types you cannot edit, register handlers globally — the same
two tiers, so the hash is optional:

```ts
import { deepEqual, deepHash } from 'valsem';

// A value: comparable, hashable, internable — under any hasher.
deepEqual.register(
  Money,
  (a, b) => a.amount === b.amount && a.currency === b.currency,
  (m, hasher) => deepHash([m.amount, m.currency], hasher),
);
// A hashFn of one parameter — the form before 0.2 — is refused at
// registration, for the same reason a precomputed [hashCode] is.

// Comparable only — deepEqual by content; deepHash and intern still refuse it.
deepEqual.register(Legacy, (a, b) => a.id === b.id);
```

**A value's registration is fixed.** Once a type is registered with a hash,
registering it again throws (repeating the identical pair is a no-op):
canonical instances were hashed and pooled by the first pair, so a
replacement would make equality depend on when a value was interned. Register
each type once, next to its class. A comparable-only registration has no such
history and may be replaced, or upgraded to a value. The mutable built-ins (`Date`,
`RegExp`, `Map`, `Set`, the TypedArrays) accept an equality only; `register`
refuses a hash for them, since a hash would declare them immutable — see
[the mutable boundary](/guide/boundary#the-contained-escape-hatch).

## One copy of valsem

A value class is a value to the copy of valsem it imported `equals` and
`hash` from, and to no other. The protocol symbols are that copy's — not
registered, not on `globalThis` — and so are its seed and its pool. If your
dependency graph ends up with two copies, a `Money` from one is refused by
the other wherever a value is required, with a message that names the
other copy and the fix; `deepEqual` compares it by reference and warns in
development. So a **library** that uses valsem declares it a peer
dependency, and an **application** keeps one copy installed. Plain data has
no copy and crosses freely.

## Interned value types with `createInternPool`

`intern` already pools any class with `[equals]` and `[hash]`, so you do
not need a pool to get canonical instances — you need one when you want them
**by construction**: `Point.of(1, 2) === Point.of(1, 2)` with no `intern`
call anywhere, the same deal the built-in collections get. Allocate a
per-class `InternPool`, route construction through it, and mark the type
`[interned]` so every walk recognises its instances as canonical in O(1):

```ts
import { createInternPool, equals, hash, interned, mix, type Hasher } from 'valsem';

const pool = createInternPool<Point>();

class Point {
  declare readonly [interned]: true;

  private constructor(readonly x: number, readonly y: number) {}

  [equals](other: unknown): boolean {
    return other instanceof Point && other.x === this.x && other.y === this.y;
  }

  [hash](hasher: Hasher): number {
    return mix(hasher.number(this.x), hasher.number(this.y));
  }

  static of(x: number, y: number): Point {
    return pool.intern(new Point(x, y)); // hashed and stamped, frozen, marked interned, deduplicated
  }
}

Point.of(1, 2) === Point.of(1, 2); // true
```

`pool.intern` freezes the instance, sets `[interned] = true`, and returns the
canonical copy — a cache hit discards the argument without allocating. A
per-class pool needs no type tag in its hashes: there is no cross-type
collision risk because each pool only ever holds one type.

::: warning The private constructor is part of the contract
`[interned]` declares an *auto-interning type* — every instance canonical by
construction, with no publicly reachable way to build one around the pool.
valsem leans on that: `intern` returns marked values without a lookup, and
`deepEqual` concludes on any non-identical pair the moment either side is
marked (same type would mean both marked; a mixed pair is cross-kind). A type
that exposes non-interning construction must not carry the marker.

A constructor that freezes its instances before `pool.intern` sees them keeps
the marker out as well: an own property cannot be added to a frozen object.
`pool.intern` pools such an instance all the same and recognises it on its
next visit, but the rest of valsem meets it as an unmarked value type, pooled
by its equality and hash on first sight — a lookup where the marker is a
property read. Let `pool.intern` do the freezing.
:::

## Temporal: `valsem/temporal`

Temporal support is a side-effect import, so consumers who do not use Temporal
pay nothing for it:

```ts
import 'valsem/temporal';
```

That one line registers, for all eight Temporal types, an equality handler, a
companion hash, and an immutability declaration (so `intern` pools them).

```ts
import { deepEqual, intern } from 'valsem';

deepEqual(PlainDate.from('2026-08-31'), PlainDate.from('2026-08-31')); // true
intern(PlainDate.from('2026-08-31')) === intern(PlainDate.from('2026-08-31')); // true
```

Without the import, Temporal values fall back to reference semantics and
`deepHash` throws — with an error naming this import.

::: info Duration compares strictly field-wise, not by Duration.compare
`Duration` is the one kind with no `equals()` method, and no total equality
exists for it: `Duration.compare` calls `P1D` and `PT24H` equal but *throws*
on `P1M` vs `P30D` without a `relativeTo`, and an equality that throws cannot
back a hash table. So valsem compares a `Duration` on its ten fields, years
through nanoseconds — equal exactly when no accessor can tell them apart.
`PT0H` equals `PT0M` (every field is 0); `P1D` does **not** equal `PT24H`,
`PT1H` does **not** equal `PT60M`, and `{ milliseconds: 1500 }` does **not**
equal `{ seconds: 1, milliseconds: 500 }` even though both print `PT1.5S` —
ISO 8601 has no sub-second units, and an equivalence drawn where a text
format folds is an accident, not a semantics. Normalise before valsem sees
them (`round`, `total`) if you need `compare` semantics.
:::

::: info ZonedDateTime time-zone aliases are distinct values
Temporal's own `ZonedDateTime.equals()` treats `[Asia/Calcutta]` and
`[Asia/Kolkata]` as equal — it resolves link names to their primary
identifier — but preserves the identifier as supplied, so `.timeZoneId`,
`toString()` and `toJSON()` all differ. By the same standard as `Duration`,
valsem compares a `ZonedDateTime` on `epochNanoseconds`, `timeZoneId` and
`calendarId`: alias spellings are different values. Case and offset formatting
are canonicalised by Temporal at construction (`asia/kolkata` →
`Asia/Kolkata`, `+0530` → `+05:30`), so only link names are affected — and
equality no longer depends on the runtime's tz link table (`Europe/Kiev`
became a link to `Europe/Kyiv` only in 2022). To merge aliases, normalise
first: `zdt.withTimeZone(canonicalId)`.
:::

## Bring your own draftable

`produce` knows two shapes natively — plain objects and arrays. Everything
else it drafts arrives through one protocol, and the built-in
`ValueMap`/`ValueSet`/`ValueList` are simply its first three users: a class
implements `[toDraft](parent)` and returns a *draft state* built with the
`valsem/draft` toolkit. This is also what keeps the package small: `produce`
never imports the collections, so a bundle that uses only `produce` carries
none of them (about 10 KB gzipped), and a bundle that uses only `ValueMap` carries
no proxies.

A draft state has:

- `draft` — the object the recipe receives; your mutable twin.
- `finalize(state, path, recorder)` — called once, only if something changed:
  return the canonical result, resolving children with `resolve()`, and, when
  `path` is not null, push this container's patches into `recorder` (forward
  into `patches`, inverse `unshift`ed into `inverse`).
- optionally `applyPatch(state, patch)` and `childAt(state, segment)`, so
  `applyPatches` can route patches to your draft and navigate through it. A
  kind with `childAt` should also supply `replaceChild(state, segment,
  value)`: when one modified child draft sits in two places, produce
  describes it at its home slot with a `replace` patch, and that hook is how
  it lands under your kind.
- optionally `snapshot(state)` — the value as it stands right now, built
  from your bookkeeping without touching the state, children passed through
  `snapshotOf()`. This is what `current()` reads; it interns what you return.
  A kind without it rejects `current()` with an error naming the kind.

Your draft calls `assertUnrevoked(state)` before every operation (drafts do
not survive the recipe) and `markChanged(state)` after every mutation (it
bubbles to the root). Nested values are drafted with `createChildDraft` on
first read — the immer rule — and `Draft<T>` infers your draft type from
`[toDraft]`'s return type, so recipes are fully typed.

The complete example — a canonical `Interval` with a nested record, its own
patch kind, and `applyPatches` support — is
[`src/draftable.test.ts`](https://github.com/andershessellund/valsem/blob/main/src/draftable.test.ts)
in the repository; the essential shape is:

```ts
import {
  toDraft, DRAFT_STATE, createDraftState, markChanged, assertUnrevoked,
  createChildDraft, resolve, snapshotOf, isDraft, isDraftable,
  type DraftState, type PatchPath, type PatchRecorder, type Patch,
} from 'valsem/draft';

// Your own patch kind, merged into the union so `patch.kind` narrows exactly.
declare module 'valsem/draft' {
  interface PatchKinds {
    'interval.set': { kind: 'interval.set'; path: PatchPath; lo: number; hi: number };
  }
}

interface IntervalState extends DraftState<Interval> {
  kind: 'interval';
  lo: number;
  hi: number;
  meta: unknown; // the nested record, replaced by a child draft on first read
  draft: IntervalDraft;
}

class Interval {
  // …canonical value type: private constructor, pool, [equals], [hash]…
  [toDraft](parent?: DraftState): IntervalState {
    const state = createDraftState<IntervalState>({
      kind: 'interval', parent, base: this,
      lo: this.lo, hi: this.hi, meta: this.meta,
      draft: null as unknown as IntervalDraft,
      finalize: finalizeInterval,
      applyPatch: applyIntervalPatch,
      snapshot: (s) => Interval.of((s as IntervalState).lo, (s as IntervalState).hi, snapshotOf((s as IntervalState).meta) as { label: string }),
      childAt: (s, segment) => (segment === 'meta' ? (s as IntervalState).draft.meta : undefined),
    });
    state.draft = new IntervalDraft(state);
    return state;
  }
}

class IntervalDraft {
  declare readonly [DRAFT_STATE]: IntervalState;
  constructor(state: IntervalState) {
    Object.defineProperty(this, DRAFT_STATE, { value: state, enumerable: false });
  }
  get #state() { const s = this[DRAFT_STATE]; assertUnrevoked(s); return s; }
  get hi() { return this.#state.hi; }
  set hi(v: number) { const s = this.#state; if (v !== s.hi) { s.hi = v; markChanged(s); } }
  get meta() {
    const s = this.#state;
    if (!isDraft(s.meta) && isDraftable(s.meta)) s.meta = createChildDraft(s.meta, s);
    return s.meta as { label: string };
  }
  // …lo likewise…
}

function finalizeInterval(state: DraftState<Interval>, path: PatchPath | null, recorder?: PatchRecorder) {
  const s = state as IntervalState;
  const meta = resolve(s.meta, path === null ? null : [...path, 'meta'], recorder) as { label: string };
  const result = Interval.of(s.lo, s.hi, meta);
  if (recorder && path !== null && (s.lo !== s.base.lo || s.hi !== s.base.hi)) {
    recorder.patches.push({ kind: 'interval.set', path, lo: s.lo, hi: s.hi });
    recorder.inverse.unshift({ kind: 'interval.set', path, lo: s.base.lo, hi: s.base.hi });
  }
  return result;
}

function applyIntervalPatch(state: DraftState<Interval>, p: Patch) {
  if (p.kind !== 'interval.set') throw new Error(`cannot apply ${p.kind} to an interval`);
  const d = (state as IntervalState).draft;
  d.lo = p.lo;
  d.hi = p.hi;
}
```

With that in place, an `Interval` drafts anywhere a value can sit — at the
root, inside a record, inside a `ValueList` — with patches that round-trip
and `current()`/`original()` that see through it:

```ts
const next = produce(intern({ range: Interval.of(0, 10) }), (d) => {
  d.range.hi = 5;          // typed: Draft<{ range: Interval }> is { range: IntervalDraft }
  d.range.meta.label = 'b';
});
next.range === Interval.of(0, 5, { label: 'b' }); // true — canonical
```

Two conventions to keep: a no-op edit must leave the state unmodified (check
`v !== s.hi` before `markChanged`), so that `produce(x, () => {}) === x`
holds through your type; and `finalize` must return the canonical instance
(build it through your interning factory), or equal results would not be
`===`.
