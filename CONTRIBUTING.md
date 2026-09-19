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
pnpm test:polluted   # the same suite with Array.prototype polluted; see below
pnpm lint
```

`test:polluted` defines every small index on `Array.prototype` and runs the
suite again. An array hole is not `undefined`: it reads the prototype chain,
and so do `slice`, spread, `map` and `for…of`. Any walk over an array that
may be raw goes through `ownAt`/`ownElements` in `src/shared.ts`, and an
internal array is filled before it is read. A failure in this run and not in
the ordinary one is a hole read.

CI runs exactly these on Node 22 and on the latest Node. The Temporal suites
need a runtime with a native `Temporal` and skip themselves without one.

## Pull requests

Every change reaches `main` through a pull request; direct pushes are blocked
for everyone. PRs are squash-merged, so **the PR title becomes the commit on
`main`**, and the PR description becomes its body.

The title must be a [Conventional Commit](https://www.conventionalcommits.org):

| Title | Meaning | Release |
| --- | --- | --- |
| `fix: …` | a bug fix | patch |
| `feat: …` | new public API or behaviour | minor |
| `feat!: …` / `fix!: …` | a breaking change | major |
| `docs:` `test:` `refactor:` `perf:` `ci:` `build:` `chore:` | no change a user can observe | none |

**The description is part of the commit too**, and release-please parses the
whole message with a strict grammar. A commit it cannot parse is dropped from
the changelog without an error, which once lost two real fixes. The usual
cause is a line of code that starts like a commit header, such as
`produce(intern(x), …)`. The `release notes can be generated` check runs the
same parser on what the squash commit will be, and tells you the offending
line. Reword it, or add an override block to the description; release-please
then reads only what is between the markers:

```
BEGIN_COMMIT_OVERRIDE
fix: one line per changelog entry
END_COMMIT_OVERRIDE
```

The same block, added to an already merged PR, corrects its release notes
after the fact.

A breaking change also carries a `BREAKING CHANGE: …` paragraph in the
description, saying what breaks and what to do instead. Write the title as the
changelog line you would want to read: it is one.

What a PR should contain:

- **Tests.** A bug fix starts with a test that fails without it. Property and
  adversarial suites exist; extend them when the change touches a law they state.
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
- anything prefixed with `_` or marked `@internal`, and the layout of `dist/`;
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
