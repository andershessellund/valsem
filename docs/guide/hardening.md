# Hardening

valsem is designed to sit on paths that ingest foreign data — cache keys,
decoded payloads, dedup gates. Three mechanisms keep that safe.

## Seeded, flood-resistant hashing

The default leaf hash is a per-process **seeded Marvin32** (the algorithm .NET
ships for DoS-resistant string hashing), drawn from `crypto.getRandomValues`,
so an attacker cannot precompute inputs that collide into one bucket. The
32-bit hashes are for bucketing, not authentication.

The seed has to reach the *structure* too, not only the leaves. A container's
hash combines its entries' hashes, and a combiner with public coefficients can
be collided without knowing any leaf hash at all. valsem's are built so that
every term is non-linear in a seeded quantity: a record entry is mixed with
its key's hash, an array element with its position's, and the collections
chain their entries through the same mix. A handful of hashes are the same in
every process, because they have no content to seed: `null`, `undefined`,
`true`, `false`, and the empty containers. That is one value each, which
gives an attacker nothing to multiply.

For untrusted-input deployments that also worry about seed recovery via
timing, swap in a keyed PRF:

```ts
import { configureHasher, getHashSeed, type Hasher } from 'valsem';

const key = getHashSeed();
const sip: Hasher = {
  string: (s) => sipHash(key, s),
  number: (n) => sipHashNum(key, n),
};
configureHasher(sip); // once, at startup, before any hashing
```

`configureHasher` is one-shot by design: hashes are baked into interned values
and the collections' accumulators, so swapping mid-run would corrupt identity.
Web Crypto (`globalThis.crypto`) is a platform requirement, present in every
environment that meets the [feature floor](/guide/requirements).

## Depth-capped admission

`intern`, `deepHash`, and `produce`'s adoption walk foreign input recursively,
so hostile (or cyclic) input would otherwise exhaust the stack. Nesting deeper
than **512** levels is rejected with a teaching error; cyclic input gets the
same teaching error instead of a bare stack overflow.

```ts
import { configureLimits } from 'valsem';

configureLimits({ maxDepth: 2000 }); // if your data is honestly that deep
```

Unlike the hasher, the cap is not baked into values — it may be reconfigured
at any time. `deepEqual` is deliberately **uncapped**: a cap would change
verdicts on honestly deep equal structures. It is total over admitted values
(nothing deeper than the cap gets through), but on raw, never-admitted input
it is an ordinary recursive walk — cyclic input, or nesting deeper than the
engine's stack, overflows the stack like any recursive comparison. Admit
untrusted data before comparing it.

Size limits are deliberately absent: admission is O(n) with no amplification,
and byte budgets belong to the transport layer (a JSON body limit), not the
value layer.

## Weak pools, idle-time cleanup

The global pool holds canonical instances via `WeakRef` — values are reclaimed
by GC the moment your program stops referencing them, so interning cannot grow
memory without bound. Pool bookkeeping is reclaimed in idle time: one global
`FinalizationRegistry` reports each death after the major GC that collects it
(the only moment anything can be dead — scavenges never clear a `WeakRef`),
the callback merely parks the dead slot, and the bucket cleanup runs under
`requestIdleCallback` (browser windows) or `setImmediate` (Node, Bun) in
bounded slices — so a large post-GC batch never becomes one long task on the
main thread. Where neither exists, cleanup runs inside the callback. The
parked stack is bounded (100k); past that, deaths are reclaimed inline until
idle time catches up. The measurements behind this choice — frame-loop,
pool-churn and collection benchmarks on V8 and JavaScriptCore — are in the
repository's `BENCHMARKS.md`.

## How large a state: memory, and the hash table behind every value

What a large state costs and saves, measured, so that you can tell where
your application sits. Two things decide it, and neither is the size of the
state as such: how many **distinct** plain records and arrays are alive, and
how fast **novel** ones are made.

**Memory.** Equal values are one instance, so what a state weighs follows
its distinct content. A canonical object costs about 280 bytes on V8 on top
of the object itself (a pool slot, a registry cell, an entry in the table
below). A million rows of five fields with a nested record and a small
array, held at once:

| distinct contents among the million | plain objects | interned |
| --- | --- | --- |
| 10,000 | 290 MB | 13 MB |
| 100,000 | 311 MB | 54 MB |
| 1,000,000 (nothing repeats) | 313 MB | 448 MB |

Data that repeats gets far smaller; data in which nothing repeats gets 1.4
times larger.

**A pause, for novel records under a large live set.** One `WeakMap` holds
the hash of every canonical plain record and array. An engine rebuilds a
hash table in one go, inside the `set` that found it full, and the entries
of collected objects count towards full until then. So making *novel*
records and arrays costs a pause now and then, inside an `intern` or a
`produce`. Its length follows the number of distinct records and arrays
alive; its frequency follows the rate of novel ones. Measured on V8 with the
live set held constant, the collector's own pauses excluded:

| distinct live records and arrays | one pause | once per |
| --- | --- | --- |
| 100,000 | 30–55 ms | ~65,000 novel ones |
| 1,000,000 | 700–750 ms | ~500,000 novel ones |

Every engine does this, V8 most expensively: a bare `WeakMap` under the same
churn, one `set`, takes 25 ms at 100,000 live keys and 120–380 ms at a
million on V8, 6 and 23 ms on JavaScriptCore, 13 and 28 ms on SpiderMonkey.

What does **not** pay it:

- **Values that recur.** A refetch, a cache fill, a row seen before: a pool
  hit makes nothing novel. A server that mostly reads, or whose writes
  mostly repeat known content, rarely reaches the threshold.
- **The collections.** The nodes and wrappers of `ValueList`, `ValueMap`,
  `ValueSet`, `OrderedMap` and `OrderedSet` carry their hash themselves and
  live in pools of their own. A `ValueMap` of a million numbers, with novel
  entries set under it, has no operation over 18 ms that is not the
  collector's. (Plain records *inside* a collection are records like any
  other.)
- **Your own value types** pooled with
  [`createInternPool`](/guide/extending#interned-value-types-with-createinternpool),
  for the same reason: the hash is on the instance.

So, in practice: up to tens of thousands of distinct live records the pause
is below a frame and rare. Around a hundred thousand it is a dropped frame
or two on V8 per tens of thousands of novel records: a bulk load of new
content shows it, interaction does not. With millions of distinct records
**and** a steady stream of novel ones, it is most of a second, regularly,
on V8; there, keep what is bulk in collections of primitives or in pooled
value classes, and a payload you only show a window of in a
[`RawArray`](/guide/collections#things-you-are-unlikely-to-need-—-but-if-you-do),
which admits what is looked at and nothing else. Two designs that would
remove the pause were built and measured, and both cost more than they
saved in the common case (the repository's `DECISIONS.md`, D49). The pool's
own index does not have this problem: it is sharded, and neither stalls nor
has a ceiling.

## The two switches you own: `skipChecks()` and `skipFreezing()`

valsem enforces two promises its callers make. It **freezes** every plain
record and array it canonicalises, so the promise "nobody mutates a shared
value" is kept by the engine (a mutation throws in strict mode). And where
an API says *canonical only* — `fastEquals(a, b)` — it **checks** that the
caller kept that promise, because the alternative is a silent wrong answer
(`===` on a raw object is `false`).

Both are on by default, everywhere, and neither consults the environment:
a bundler's idea of "production" is not evidence that your answers are
right. Turning either off is a one-way, explicit, per-process decision, made
at startup, the way Angular's `enableProdMode()` is:

```ts
import { skipChecks, skipFreezing } from 'valsem';

if (process.env.NODE_ENV === 'production') {
  skipChecks();   // fastEquals trusts its arguments
  skipFreezing(); // canonical records and arrays are no longer frozen
}
```

**What `skipChecks()` gives up.** The checks cost a property read and a
cache probe, so the reason to skip them is principle, not speed: from then
on a raw argument at a *canonical only* call site is a silent wrong answer
instead of a thrown one. Semantics are untouched — non-values are still
rejected, results are still canonical.

**What `skipFreezing()` buys, and costs.** That depends on the engine: nothing
on SpiderMonkey (Firefox), where freezing is cheap and frozen arrays read at
full speed; your own loops on V8; and valsem's edits of large arrays as well
on JavaScriptCore. Frozen arrays are slow in V8.
The freeze call itself is nearly free for an array of integers or of objects
(a map transition, ~0.1 µs at any size; an array of doubles is converted
element by element, ~150 µs for 10,000), but the frozen *state* is not:
`forEach` runs 3–9× slower, `filter` 2–3×, `slice` and `concat` 10–150×,
`JSON.stringify` 2–5×, and an indexed loop over an array of small integers
12× (over objects or doubles it barely moves), and that cost lands in your
own loops over canonical state (the frozen-array
suite in the repository's `BENCHMARKS.md`). On JavaScriptCore (Safari, Bun)
the freeze *call* is O(n) as well — ~2 ms for a 10,000-element array
against 0.1 µs on V8 — so there `skipFreezing()` is the difference between
microseconds and milliseconds per edit of a large array: about 3 ms against
20 µs for one edit in a 10,000-record array (the `skipFreezing()` suite in
`BENCHMARKS.md` runs valsem's own operations and a reader's loops with the
switch on and off, on all three engines). Freezing stays the default all the same:
it is the enforcement that makes shared canonical state safe to hand around,
and the cost is one engine's, avoidable in production with one call. Records are unaffected,
and `ValueList` never pays it — its leaves are unfrozen inside a frozen
wrapper. What you give up: a mutation of a canonical value goes undetected
and corrupts every holder of that value, its cached hash, and the pool. The
immer deal applies: freeze in development and test, where a stray mutation
throws, and skip in production if plain canonical arrays sit on a hot path.
Collections and value types keep freezing their own instances (objects, at
no cost, protecting their cached hash), and drafts still copy-on-write
through an unfrozen canonical rather than write into it.

`isCanonical(value)` is the probe behind the checks — a primitive, or an
object valsem canonicalised — exposed for assertions and comparators of your
own; it is not affected by either switch.


## Prototype pollution

Two promises, both tested against hostile inputs in `src/hardening.test.ts`:

- **Records are their own keys.** Every walk — equality, hashing, interning,
  drafting, snapshots — enumerates own enumerable keys and reads them with
  `hasOwn`, never `in` or `for…in`, so a polluted `Object.prototype` never
  leaks into a value, and a `__proto__` key in JSON becomes an own data
  property of the canonical record, never a prototype change. Registry
  dispatch keys on the prototype's constructor, not the instance's
  shadowable `constructor` property.
- **Where the line is.** Two promises: valsem is never the *vector* — no input,
  key or patch path can write to a prototype — and a record's value never
  picks up an inherited key, which is what real prototype pollution looks like
  (a string key on `Object.prototype`). One thing is out of scope: a process
  whose built-in prototypes already carry **index** properties
  (`Array.prototype[1] = x`). An array element is what `arr[i]` reads, in
  valsem as in every other piece of code in that process, so a sparse array's
  hole reads that value there too. Such a process cannot trust `slice`,
  spread, `map` or `for…of` either; guarding one library's reads would not
  make it sound, and it costs every array walk. Without such pollution a hole
  is `undefined`, consistently, and canonical arrays are always dense.
- **Patches are validated, not trusted.** `applyPatches` follows a path only
  through own keys of records, in-range integer indices of arrays, and a
  draftable kind's own `childAt`; a segment such as `__proto__`,
  `constructor`, or a missing key is a bad path and throws. Patch keys and
  indices are type-checked, and a `record.set` with key `__proto__` defines
  an own property. Patches can come off a wire safely — their *values* are
  interned on application, so a value that is not a value (a function, a
  mutable built-in) is rejected as it would be anywhere.

`deepEqual` is total over admitted values and deliberately uncapped; a pair
of distinct cyclic raw objects recurses until the engine throws a
`RangeError` rather than looping. Admitting paths (`intern`, `deepHash`,
`produce`, `current`) are depth-capped and throw a teaching error instead.
