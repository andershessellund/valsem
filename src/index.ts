// ---------------------------------------------------------------------------
// valsem — value semantics for JavaScript.
//
// Structural equality (`deepEqual`), companion hashing (`deepHash`), and global
// interning (`intern` — structurally-equal values collapse to a single `===`
// canonical instance), plus value collections (`ValueList`/`ValueMap`/
// `ValueSet`/`ValueDate`/`InternedString`, `HashMap`) and the extension points
// (`equals`/`hashCode`/`interned` symbols, `createInternPool`) that let any
// type participate.
//
// Temporal value semantics live behind the `valsem/temporal` subpath; the
// stable surface for binding authors (wire formats, storage layers) behind
// `valsem/binding`.
// ---------------------------------------------------------------------------

export { deepEqual, equals, hashCode, interned } from './deep-equal.js';
export type { RegisterOptions } from './deep-equal.js';
export { deepHash } from './deep-hash.js';
export { HashMap } from './hash-map.js';
export { intern, createInterner, internHash } from './intern.js';
export { ValueList } from './value-list.js';
export { ValueMap } from './value-map.js';
export { ValueSet } from './value-set.js';
export { InternedString } from './interned-string.js';
export { ValueDate } from './value-date.js';
export { createInternPool } from './intern-pool.js';
export type { InternPool } from './intern-pool.js';
export { configureHasher, createMarvin32Hasher, getHashSeed } from './hasher.js';
export { configureLimits } from './limits.js';
export type { Hasher } from './hasher.js';
export { produce, produceWithPatches, applyPatches, nothing, isDraft, toDraft } from './produce.js';
export type { Draft, Patch, PatchPath, PatchKinds } from './produce.js';
export { current, original } from './current.js';
export type { Undraft } from './current.js';
export { DraftMap } from './draft-map.js';
export { DraftSet } from './draft-set.js';
export { DraftList } from './draft-list.js';
