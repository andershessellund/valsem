// ---------------------------------------------------------------------------
// valsem — value semantics for JavaScript.
//
// Structural equality (`deepEqual`), companion hashing (`deepHash`), and global
// interning (`intern` — structurally-equal values collapse to a single `===`
// canonical instance), plus value collections (`InternArray`/`InternMap`/
// `InternSet`/`InternString`, `HashMap`) and the extension points
// (`equals`/`hashCode`/`interned` symbols, `createInternPool`) that let any
// type participate.
//
// Temporal value semantics live behind the `valsem/temporal` subpath.
// Identity-preserving serialization lives in the `samme` package — the wire
// binding built on valsem.
// ---------------------------------------------------------------------------

export { deepEqual, equals, hashCode, interned } from './deep-equal.js';
export type { RegisterOptions } from './deep-equal.js';
export { deepHash } from './deep-hash.js';
export { HashMap } from './hash-map.js';
export { intern, createInterner, internHash, internEqual } from './intern.js';
export { InternArray } from './intern-array.js';
export { InternMap } from './intern-map.js';
export { InternSet } from './intern-set.js';
export { InternString } from './intern-string.js';
export { createInternPool } from './intern-pool.js';
export type { InternPool } from './intern-pool.js';
export { configureHasher, createMarvin32Hasher, getHashSeed } from './hasher.js';
export type { Hasher } from './hasher.js';
