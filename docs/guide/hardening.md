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

## Weak pools, cleanup without finalizers

The global pool holds canonical instances via `WeakRef` — values are reclaimed
by GC the moment your program stops referencing them, so interning cannot grow
memory without bound. The pool's own bookkeeping is dropped as interning goes
on: its index is never edited in place but replaced, one entry per
registration, and an entry whose value has been collected is simply not
carried over — so neither growing the index nor cleaning it is ever one long
task on the main thread. The pool notices a collection through a canary (a
`WeakRef` to an object nothing holds), and ignores one that left more than
half of the pool alive, so the dead number about the living at most. There is
no `FinalizationRegistry`, no timer and no idle callback, which matters on
hosts that run finalizers without an I/O context or not at all. The cost: a
pool that stops interning stops cleaning — what it keeps is a cleared
`WeakRef` and eight bytes of index per dead value, never the values — until
interning resumes. The measurements behind this choice are in the repository's
`DECISIONS.md` (D2) and reproducible with `pnpm bench:mix`.
What the pool and its bookkeeping cost when a state gets large is on the
[Performance and scale](/guide/performance#large-states-memory-and-pauses) page.

## Turning enforcement off

Freezing and the *canonical only* checks are enforcement, and both can be
switched off, once, by you: `skipFreezing()` and `skipChecks()`. What each
buys and what it gives up is on the
[Performance and scale](/guide/performance#the-two-switches-you-own-skipchecks-and-skipfreezing)
page, since speed is the only reason to touch them.

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
