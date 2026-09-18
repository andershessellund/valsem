# Requirements

valsem calls no platform APIs: no file system, no network, no DOM. What it
needs is a handful of language features, so the honest way to say where it
runs is to name them. An environment that has everything in the table below
runs valsem, whether or not it is listed here.

## The feature floor

Versions are from [MDN's browser-compat-data](https://github.com/mdn/browser-compat-data).

| Feature | What valsem uses it for | Chrome, Edge | Firefox | Safari | Node | Deno | Bun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `WeakRef`, `FinalizationRegistry` | the weak intern pools: a canonical value nobody holds is collected | 84 | 79 | 14.1 | 14.6 | 1.0 | 1.0 |
| `Proxy.revocable` | drafts of plain objects and arrays in `produce` | 63 | 34 | 10 | 6 | 1.0 | 1.0 |
| `globalThis.crypto.getRandomValues` | the per-process hash seed | 11 | 21 | 5 | 19 | 1.0 | 1.0 |
| ES2022 syntax and built-ins | private class members, `??=`, `Object.hasOwn` | 93 | 92 | 16 | 16.9 | 1.13 | 1.0 |
| The rest of ES2023 | reserved: the library may use it (`toSorted`, `findLast`, …) | 110 | 115 | 16 | 20 | 1.31 | 1.0 |
| Set methods (`union`, `isSubsetOf`, …) | reserved, and what the set-algebra signatures are typed against | 122 | 127 | 17 | 22 | 1.42 | 1.0 |
| Symbols as `WeakMap` keys | hashing a **unique** symbol (`Symbol('x')`, the well-known symbols) | 109 | 146 | 16.4 | 20.1 | 1.28 | 1.0 |

Which gives, per environment, the version where the last piece arrived:

| Environment | Minimum | Released |
| --- | --- | --- |
| Chrome, Edge | 122 | February 2024 |
| Firefox | 146 | December 2025 |
| Safari | 17 | September 2023 |
| Node | 22 | April 2024 |
| Deno | 1.42 | March 2024 |
| Bun | 1.0 | September 2023 |

Web workers and service workers have the same features as their browser.

Two rows are marked *reserved*. valsem's own code does not call those
built-ins today: `ValueSet` implements its set algebra itself, and nothing
uses an ES2023 array method. They are in the floor so that a later release
may use them without a major version. In practice this means today's code
also runs on older browsers than the table promises, back to Chrome 93,
Firefox 92 and Safari 16, as long as your values hold no unique symbols. That
is an observation about the current release, not a commitment.

### The one soft edge: unique symbols on older Firefox

Firefox's number is set by a single feature, symbols as `WeakMap` keys, and
valsem reaches it on one path only: hashing a unique symbol. On Firefox 127
to 145 everything else is within the floor, including registered symbols
(`Symbol.for('name')`), which hash by their name. A value that holds a unique
symbol, as a field or as a record key, throws a `TypeError` from the engine
when it is hashed or interned. If your values contain no unique symbols, the
practical Firefox floor is 127 (June 2024).

## What is tested

Continuous integration runs the full suite on **Node 22 and the current Node
release**. That is one engine, V8. The benchmarks also run under Bun, which
exercises the library on JavaScriptCore, Safari's engine, though as a
benchmark and not as a correctness suite. No browser runs in CI.

So the table above is a statement about features, not a record of test runs:
valsem is expected to work wherever the floor is met, and a failure on an
environment that meets it is a bug worth [reporting](https://github.com/andershessellund/valsem/issues).

The build enforces the floor. The library is compiled against exactly the
ES2023 library plus the Set methods, with no ambient platform types, so using
a newer built-in or a Node global in the source is a compile error and not a
surprise in someone's browser.

## TypeScript

TypeScript **5.6 or later**. The published declarations use the iterator
types introduced in 5.6 (`SetIterator`, `MapIterator`); 5.5 cannot read them.

Your `lib` setting should include the Set-method types, because the
set-algebra signatures refer to `ReadonlySetLike`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    // TypeScript 6 and later
    "lib": ["ES2023", "ES2025.Collection"]
    // TypeScript 5.6 to 5.9: "ESNext.Collection" is the same thing
  }
}
```

Any `lib` that contains them works too, such as `ES2025` or `ESNext`. Without
them the outcome depends on `skipLibCheck`. When it is off, you get an error
inside valsem's declarations (`Cannot find name 'ReadonlySetLike'`). When it
is on, as in most project templates, there is no error at all: the argument
of `union`, `intersection` and the other set-algebra methods is silently
unchecked. Everything else is typed normally either way.

## Packaging

ES modules only, with declarations and source maps, and no runtime
dependencies. There is no CommonJS build: `require('valsem')` works where
the runtime can `require` an ES module (Node 22.12 and later) and nowhere
else. `valsem/temporal` additionally needs a native `Temporal`, and says so
with an error at import when there is none.

## Stability

This page is the floor that [semantic versioning](https://github.com/andershessellund/valsem/blob/main/CONTRIBUTING.md#versioning)
refers to. Raising any minimum in it, or the TypeScript minimum, is a
breaking change and ships in a major version.
