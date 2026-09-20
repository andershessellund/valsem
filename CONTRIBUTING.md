# Contributing to valsem

Thanks for looking. valsem is maintained by one person, so the process is
small, but it is the same for everyone, the maintainer included.

## Before you write code

For anything beyond a small fix, open an issue first. valsem's behaviour is
argued for in [DESIGN.md](DESIGN.md) and [DECISIONS.md](DECISIONS.md); a change
that contradicts a recorded decision needs to say why the decision was wrong,
and that conversation is cheaper before the code exists.

## Setup

Node 22 or later and [pnpm](https://pnpm.io) (the version is pinned in
`package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build       # tsc
pnpm typecheck   # the tests' types too
pnpm test        # vitest
pnpm lint
pnpm check:package   # publint and are-the-types-wrong, on the packed tarball
pnpm docs:build      # the documentation site
```

CI runs the first four on Node 22 and on the latest Node, and the last two
once: they check what the tests cannot see, since the tests import from
`src/` (the `exports` map, how the published types resolve, the docs build).
The Temporal suites run against the runtime's own `Temporal` where there is
one (the latest Node) and against `temporal-polyfill`, a dev dependency, where
there is not (Node 22).

A few suites skip themselves when the runtime lacks something they need (the
`--expose-gc` and `--allow-natives-syntax` flags that `vitest.config.ts`
passes, iterator helpers). CI provides all of it, so in CI a skipped test
fails the run: a suite that quietly stopped running looks exactly like a
passing one.

## Where a test goes

Tests sit beside the source, in `src/`, and come in four kinds. The kind
decides the file.

- **One type's behaviour** goes in that type's file (`ordered-map.test.ts`):
  what `insertAt` does, which errors it throws, the sizes where its structure
  changes shape.
- **A law of the whole library** gets a file of its own, named for the law
  (`negative-zero`, `markers`, `iteration`, `intern-on-entry`, `symbols`), and
  runs over the **roster** in `roster.test-helpers.ts`: one table of every
  value type, in the shape a law needs. A law holds for every type, so it must
  not keep a list of its own; such lists are complete on the day they are
  written. `roster.test.ts` checks the table against what `index.ts` exports,
  so a new value type fails the build until it is enrolled, and is under every
  law once it is. The `property-*` files are laws too, stated over generated
  values: their domain is `property.test-helpers.ts`, and a new type belongs
  in `valueTree` and `shuffledClone` there. (A property test of ONE type stays
  in that type's file; the prefix means "law", not "uses fast-check".)
- **Hostile input** goes in `hardening.test.ts` when it is a threat stated in
  advance (prototype pollution, forged markers, malformed patches), and in
  `adversarial.test.ts` when it is a defect that shipped, or its neighbour,
  pinned so it stays fixed. `produce-corpus*.test.ts` is the same idea for
  cases taken from other libraries' suites.
- **Once-per-process state** gets a file to itself, because vitest gives each
  file its own process: a replaced hasher (`hamt-collisions`, `collisions`),
  `skip-checks`, `skip-freezing`, a second copy of the module graph
  (`duplicate-install`). These are why `isolate` stays on.

Shared machinery is in `*.test-helpers.ts` (kept out of the build and the
package): the roster, the property arbitraries, `expectPatchRoundTrip` for the
two patch laws, `withPolluted`, a seeded rng. `rng.test-helpers.ts` imports
nothing from valsem, on purpose: the collision suites install their hasher
before any collection loads.

`pnpm test:coverage` prints what no test reaches. There is no threshold; read
the uncovered lines when reviewing. What is left uncovered is mostly "this is
a bug" guards and hash coincidences no test can arrange, and the collision
suites exist because that list once held working code.

## Pull requests

Every change reaches `main` through a pull request; direct pushes are blocked
for everyone. PRs are squash-merged, and **the PR title becomes the whole
commit on `main`**. The description stays on the pull request, which the
number in the commit title links to; it is not part of the commit.

The title must be a [Conventional Commit](https://www.conventionalcommits.org):

| Title | Meaning | Release |
| --- | --- | --- |
| `fix: …` | a bug fix | patch |
| `feat: …` | new public API or behaviour | minor |
| `feat!: …` / `fix!: …` | a breaking change | major |
| `docs:` `test:` `refactor:` `perf:` `ci:` `build:` `chore:` | no change a user can observe | none |

release-please builds the changelog from that title. When one title is not
enough, add an **override block** to the description. release-please then
reads only what is between the markers, in place of the title:

```
BEGIN_COMMIT_OVERRIDE
fix: the first changelog entry

fix: a second entry, for a PR that fixed two things
END_COMMIT_OVERRIDE
```

The block is also where a footer goes, below a header line and a blank line,
since the description itself is not a commit message and a footer written
there is never seen:

- a breaking change that needs explaining: `BREAKING CHANGE: what breaks, and
  what to do instead`. (A `!` in the title is enough to mark one; the footer
  adds the explanation to the changelog.)
- forcing a version: `Release-As: 1.0.0`.

Whatever release-please cannot parse, it drops without an error: no changelog
entry, no effect on the version. The `release notes can be generated` check
runs the same parser over the title and the block, and fails on a footer left
outside one. The same block, added to an already merged PR, corrects its
release notes after the fact.

Write the title as the changelog line you would want to read: it is one.

What a PR should contain:

- **Tests.** A bug fix starts with a test that fails without it. A new value
  type is enrolled in the roster and the property arbitraries; a change that
  touches a law extends that law's suite ([where a test goes](#where-a-test-goes)).
- **Docs**, when behaviour changes: the guide page, `docs/api.md`, and the
  `DESIGN.md` section.
- **A `DECISIONS.md` entry**, when the change makes or reverses a design choice:
  what was decided, why, and what was rejected.
- **Benchmarks**, when the change is about performance: numbers from
  `pnpm bench`, before and after.

## Versioning

valsem follows [Semantic Versioning](https://semver.org). The public API is
everything exported from `valsem`, `valsem/temporal`, `valsem/binding` and
`valsem/draft`, with its documented behaviour and its TypeScript types.

Breaking, and therefore a major version:

- removing or renaming an export, or changing a signature incompatibly;
- changing what is a value: what `intern`, `deepHash` and `produce` admit or reject;
- changing equality: two values that compared equal no longer do, or the reverse;
- changing the patch vocabulary or a patch's meaning;
- raising the floor: the minimum Node version, or any minimum on the
  [Requirements](docs/guide/requirements.md) page, the TypeScript one included.

Not part of the API, and free to change in any release:

- **hash values**, which are seeded per process and never stable across runs;
- **iteration order of the unordered collections**, which follows the hashes;
- **the text of error messages** (that an operation throws, and the error's
  type, are API; its wording is not);
- anything prefixed with `_` or marked `@internal`, and the layout of `dist/`.
  What is tagged `@internal` is also stripped from the published types
  (`stripInternal`), so tag every `_` member you add, unless the declarations
  still need it: a re-export (`valsem/binding`), or a helper type a public
  type is spelled with (`_IsPlainArray` in `Draft<T>`). `declarations.test.ts`
  fails on a tag that breaks a consumer's build, and lists what is left;
- performance characteristics, short of a documented complexity guarantee.

A type-only change that can break a build that compiled before is treated as
breaking, with one exception: corrections to a type that was wrong about the
runtime's behaviour are fixes.

## Releases

Releases are automated. [release-please](https://github.com/googleapis/release-please)
keeps a release PR open with the next version and the `CHANGELOG.md` entries
computed from the merged PR titles. Merging it tags the commit and creates the
GitHub Release; CI then stages the package on npm, and it goes live once the
maintainer approves the staged tarball. Do not edit the version in
`package.json` or `CHANGELOG.md` by hand.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the
project's [Apache-2.0 licence](LICENSE).
