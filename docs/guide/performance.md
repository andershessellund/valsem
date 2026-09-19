# Performance and scale

valsem moves work from comparing to building: every value is hashed and
canonicalised when it is made, and everything after that (equality, keys,
memoization, change detection) is a pointer comparison. The
[benchmarks](/benchmarks) have the numbers for both sides, against immer,
mutative, Immutable.js and fast-deep-equal. This page is about the two
things that are yours to decide: whether to keep freezing on in production,
and how to hold a state that gets large.

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

## Large states: memory and pauses

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
