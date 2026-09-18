# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub:
**[Report a vulnerability](https://github.com/andershessellund/valsem/security/advisories/new)**.
Do not open a public issue or pull request for one.

A useful report says what an attacker controls, what they gain, and how to
reproduce it, ideally as a short script against a published version.

valsem is maintained by one person. Reports are read and acknowledged as soon
as possible, and you will be told whether the report is accepted and what the
plan is. Fixes are released as a patch version with a GitHub security advisory,
crediting the reporter unless they prefer otherwise.

## Supported versions

Security fixes go into the latest published version only.

## What counts

valsem is a library that admits untrusted data at a boundary (`intern`,
`deepHash`, `produce`, `applyPatches`). [The hardening guide](docs/guide/hardening.md)
states what it defends against. Violations of those claims are in scope, for
example:

- prototype pollution, or a `__proto__`/`constructor` key behaving as anything
  but data, through any admission path;
- input that defeats the depth limit, or exhausts the stack or memory out of
  proportion to its size during admission;
- collisions that can be precomputed against the seeded hash, degrading the
  pools or the hash collections;
- a way to mutate a canonical value, or to make two canonical values that are
  equal by content differ by identity, without `skipFreezing()` or
  `skipChecks()`;
- a draft that remains usable after its `produce()` call, or crosses into another.

Out of scope, by documented design:

- `deepEqual` on raw cyclic input overflowing the stack: it is uncapped on
  purpose, and the admission functions are the boundary;
- the 32-bit hash as anything stronger than a bucket-flooding defence: it is
  not a MAC and not collision-resistant against an attacker who learns the seed;
- corruption after opting out with `skipFreezing()` or `skipChecks()`;
- a custom value type whose `[hashCode]` promise of immutability is false.

## How releases are protected

Published versions are built and staged by GitHub Actions from a tagged commit,
authenticated to npm by OIDC trusted publishing: no npm token exists. A staged
version goes live only after the maintainer approves it with a second factor,
and carries a provenance attestation linking it to its source commit and
workflow run. Release tags cannot be moved or deleted.
