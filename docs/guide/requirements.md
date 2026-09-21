# Requirements

valsem calls no platform APIs: no file system, no network, no DOM. What it
needs is a handful of language features, so the honest way to say where it
runs is to name them. An environment that has everything in the table below
runs valsem, whether or not it is listed here.

## The feature floor

Versions are from [MDN's browser-compat-data](https://github.com/mdn/browser-compat-data).

| Feature | What valsem uses it for | Chrome, Edge | Firefox | Safari | Deno | Bun |
| --- | --- | --- | --- | --- | --- | --- |
| `WeakRef` (and, where present, `FinalizationRegistry`: one sentinel, to clean pools in idle time) | the weak intern pools: a canonical value nobody holds is collected | 84 | 79 | 14.1 | 1.0 | 1.0 |
| `Proxy.revocable` | drafts of plain objects and arrays in `produce` | 63 | 34 | 10 | 1.0 | 1.0 |
| `globalThis.crypto.getRandomValues` | the per-process hash seed | 11 | 21 | 5 | 1.0 | 1.0 |
| ES2022: class fields, private members, `Object.hasOwn` | throughout | 93 | 92 | 16 | 1.13 | 1.0 |
| Symbols as `WeakMap` keys | **only** to hash a unique symbol (`Symbol('x')`, the well-known symbols) | 109 | 146 | 16.4 | 1.28 | 1.0 |

Which gives two floors, depending on one question: do your values contain
unique symbols?

| Environment | Minimum | Released | With unique symbols in values | Released |
| --- | --- | --- | --- | --- |
| Chrome, Edge | 93 | August 2021 | 109 | January 2023 |
| Firefox | 92 | September 2021 | 146 | December 2025 |
| Safari | 16 | September 2022 | 16.4 | March 2023 |
| Deno | 1.13 | August 2021 | 1.28 | November 2022 |
| Bun | 1.0 | September 2023 | 1.0 | September 2023 |
| Node | 22 | April 2024 | 22 | April 2024 |

Node's row is a support statement and not a feature calculation: the features
are in older releases, but 22 is the oldest version valsem is tested on, and
the one `engines` declares. Web workers and service workers have the same
features as their browser.

### Unique symbols

Most values never contain one. Registered symbols (`Symbol.for('name')`) hash
by their name and need nothing special. A **unique** symbol has no content to
hash, so valsem gives it an identity number and remembers it in a `WeakMap`
keyed by the symbol, which is the newest feature on this page and the only
reason for the second column. On an engine without it, everything else
works, and a value that holds a unique symbol, as a field or as a record key,
throws the engine's `TypeError` when it is hashed or interned.

## What is tested

Continuous integration runs the full suite on **Node 22 and the current Node
release**. That is one engine, V8. The benchmarks also run under Bun, which
exercises the library on JavaScriptCore, Safari's engine, and their
engine-level suites in Mozilla's SpiderMonkey shell, Firefox's engine,
though as benchmarks and not as a correctness suite, and as engines and not
as browsers. No browser runs in CI.

So the tables above are a statement about features, not a record of test
runs: valsem is expected to work wherever the floor is met, and a failure on
an environment that meets it is a bug worth [reporting](https://github.com/andershessellund/valsem/issues).

The floor is enforced, not just documented. The library is compiled against
exactly the ES2022 library plus the typing for symbol-keyed `WeakMap`s, with
no ambient platform types, so a newer built-in or a Node global in the source
is a compile error. A lint rule holds off the two pieces of ES2022 syntax
that arrived later than the rest, static blocks and top-level await.

## TypeScript

TypeScript **5.6 or later**. The published declarations use the iterator
types introduced in 5.6 (`SetIterator`, `MapIterator`); 5.5 cannot read them.

No particular `lib` setting is needed beyond `ES2015`, with `skipLibCheck` on
or off: the declarations refer to nothing newer. `ValueSet` and `OrderedSet`
are nonetheless set-like in the ES2025 sense, so if your own `lib` has the
native Set methods, they accept valsem's sets: `nativeSet.union(valueSet)`.

## Packaging

ES modules only, with declarations and source maps, and no runtime
dependencies. There is no CommonJS build: `require('valsem')` works where
the runtime can `require` an ES module (Node 22.12 and later) and nowhere
else. `valsem/temporal` additionally needs a native `Temporal`, and says so
with an error at import when there is none.

## Stability

This page is the floor that [semantic versioning](https://github.com/andershessellund/valsem/blob/main/CONTRIBUTING.md#versioning)
refers to. Raising any minimum on it, or the TypeScript minimum, is a
breaking change and ships in a major version.
