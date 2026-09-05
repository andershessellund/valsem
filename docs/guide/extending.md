# Making your own types values

Three well-known symbols let any class opt into value semantics. Import them
and implement whichever the operation needs:

| Symbol       | Enables                          | Shape                            |
| ------------ | -------------------------------- | -------------------------------- |
| `equals`     | `deepEqual`                      | `[equals](other): boolean`       |
| `hashCode`   | `deepHash`                       | `[hashCode]: number` (or method) |
| `interned`   | auto-interning type contract     | `[interned]: true`               |

```ts
import { equals, hashCode } from 'valsem';

class Money {
  constructor(readonly amount: number, readonly currency: string) {}

  [equals](other: unknown): boolean {
    return other instanceof Money
      && other.amount === this.amount
      && other.currency === this.currency;
  }

  get [hashCode](): number {
    return (this.amount * 31 + hashString(this.currency)) >>> 0;
  }
}

deepEqual(new Money(5, 'DKK'), new Money(5, 'DKK')); // true
```

Implement `equals` and `hashCode` **together** — the companion invariant
(`equals ⟹ same hashCode`) is what makes hashing and interning correct.

For third-party types you cannot edit, register a handler pair globally:

```ts
import { deepEqual, deepHash } from 'valsem';

deepEqual.register(
  Money,
  (a, b) => a.amount === b.amount && a.currency === b.currency,
  (m) => deepHash(`${m.amount}|${m.currency}`),
);
```

Add `{ immutable: true }` as a fourth argument when instances genuinely cannot
change after construction; that makes the type internable, so `intern`
collapses equal values to one canonical `===` instance instead of passing them
through. Only claim it if it is true — the pooled instance is shared by every
holder.

## Interned value types with `createInternPool`

To get canonical `===` instances for your own class — the same deal the
built-in collections get — allocate a per-class `InternPool` and route
construction through it. Give the class a `[hashCode]`, an `[equals]`, and let
the pool deduplicate:

```ts
import { createInternPool, equals, hashCode, interned } from 'valsem';

const pool = createInternPool<Point>();

class Point {
  declare readonly [hashCode]: number;
  declare readonly [interned]: true;

  private constructor(readonly x: number, readonly y: number) {}

  [equals](other: unknown): boolean {
    return other instanceof Point && other.x === this.x && other.y === this.y;
  }

  static of(x: number, y: number): Point {
    const p = new Point(x, y);
    (p as any)[hashCode] = (x * 73856093) ^ (y * 19349663);
    return pool.intern(p); // frozen, marked interned, deduplicated
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
none of them (8 KB gzipped), and a bundle that uses only `ValueMap` carries
no proxies.

A draft state has:

- `draft` — the object the recipe receives; your mutable twin.
- `finalize(state, path, recorder)` — called once, only if something changed:
  return the canonical result, resolving children with `resolve()`, and, when
  `path` is not null, push this container's patches into `recorder` (forward
  into `patches`, inverse `unshift`ed into `inverse`).
- optionally `applyPatch(state, patch)` and `childAt(state, segment)`, so
  `applyPatches` can route patches to your draft and navigate through it.
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
  // …canonical value type: private constructor, pool, [equals], [hashCode]…
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
