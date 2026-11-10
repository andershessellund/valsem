// ---------------------------------------------------------------------------
// valsem/extend — making your own types values.
//
// Application code uses values; a few modules in an application, and the
// libraries built on valsem, DEFINE them. What only a definition needs lives
// here and not in the main entry point, so that the barrel an application
// autocompletes against holds what an application calls:
//
// - `equals`, `hash`, `interned` — the protocol symbols a class implements.
// - `registerType` — the same declaration for a type you cannot edit.
// - `createInternPool` — a typed weak pool, for a class whose instances are
//   canonical by construction.
// - `mix` — the combiner a `[hash]` method folds leaf hashes with.
// - `getHashSeed` — this copy's seed, for keying a hasher of your own (the
//   one `configureHasher`, in the main entry point, installs).
//
// `toDraft` and the draft toolkit are `valsem/draft`. Covered by semver like
// every other entry point.
// ---------------------------------------------------------------------------

export { equals, hash, interned, registerType } from './deep-equal.js';
export { createInternPool } from './intern-pool.js';
export type { InternPool } from './intern-pool.js';
export { getHashSeed, mix } from './hasher.js';
export type { Hasher } from './hasher.js';
