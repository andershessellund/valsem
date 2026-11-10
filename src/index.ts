// ---------------------------------------------------------------------------
// valsem — value semantics for JavaScript.
//
// Structural equality (`deepEqual`), companion hashing (`deepHash`), and global
// interning (`intern` — structurally-equal values collapse to a single `===`
// canonical instance), plus value collections (`ValueList`/`ValueMap`/
// `ValueSet`, the insertion-ordered `OrderedMap`/`OrderedSet`, `ValueDate`/
// `InternedString`/`RawArray`, the mutable `HashMap`/`HashSet`), `produce`
// and `memoize`, and the application's switches.
//
// This entry point is what an application CALLS. What a module needs in
// order to DEFINE a value type — the `equals`/`hash`/`interned` symbols,
// `registerType`, `createInternPool`, `mix`, `getHashSeed` — is
// `valsem/extend`; `toDraft` and the draft toolkit are `valsem/draft` (D69).
// `hashCode`, the cache slot valsem writes a value's hash to, is a symbol
// of this copy too but not exported: a class never writes it, and `deepHash`
// is how anyone reads it. A second copy of valsem in the process is a
// separate library, whose values this one refuses with the reason (D4).
//
// Temporal value semantics live behind the `valsem/temporal` subpath; the
// stable surface for binding authors (wire formats, storage layers) behind
// `valsem/binding`.
// ---------------------------------------------------------------------------

export { deepEqual } from './deep-equal.js';
export { deepHash } from './deep-hash.js';
export { HashMap } from './hash-map.js';
export { HashSet } from './hash-set.js';
export { intern, isCanonical, fastEqual } from './intern.js';
export { skipChecks, skipFreezing } from './checks.js';
export { ValueList } from './value-list.js';
export type { Hunk } from './value-list.js';
export { ValueMap } from './value-map.js';
export { ValueSet } from './value-set.js';
export { OrderedMap } from './ordered-map.js';
export { OrderedSet } from './ordered-set.js';
export { InternedString } from './interned-string.js';
export { ValueDate } from './value-date.js';
export { RawArray } from './raw-array.js';
export { configureHasher, createMarvin32Hasher } from './hasher.js';
export { configureLimits } from './limits.js';
export type { Hasher } from './hasher.js';
export { produce, produceWithPatches, applyPatches, draftOf, castDraft, nothing, isDraft } from './produce.js';
export type { Draft, RecipeReturn, Patch, PatchPath, PatchKinds } from './produce.js';
export { current, original } from './current.js';
export { memoize } from './memoize.js';
export type { MemoizeOptions, Memoized } from './memoize.js';
export type { Undraft } from './current.js';
export { DraftMap } from './draft-map.js';
export { DraftSet } from './draft-set.js';
export { DraftList } from './draft-list.js';
export { DraftOrderedMap } from './draft-ordered-map.js';
export { DraftOrderedSet } from './draft-ordered-set.js';
