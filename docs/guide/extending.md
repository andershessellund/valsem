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

::: info Duration compares field-wise, not by Duration.compare
`Duration` is the one kind with no `equals()` method, and no total equality
exists for it: `Duration.compare` calls `P1D` and `PT24H` equal but *throws*
on `P1M` vs `P30D` without a `relativeTo`, and an equality that throws cannot
back a hash table. So valsem compares a `Duration` on its canonical
`toString()`: `PT0H` equals `PT0M` (both normalise to `PT0S`), while `P1D`
does **not** equal `PT24H`. Normalise before valsem sees them if you need
`compare` semantics.
:::
