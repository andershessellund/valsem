// ---------------------------------------------------------------------------
// The two patch laws, as one assertion. For what `produceWithPatches(base,
// recipe)` returned as `[next, patches, inverse]`:
//
//   1. applyPatches(base, patches) === next
//   2. applyPatches(next, inverse) === base
//
// `===`, not deepEqual: replaying lands on the canonical instance. `base`
// must therefore be canonical; a test whose base is raw input compares
// against `intern(base)` and says so itself.
// ---------------------------------------------------------------------------
import { expect } from 'vitest';
import { applyPatches, type Patch } from './produce.js';

export function expectPatchRoundTrip(base: unknown, next: unknown, patches: readonly Patch[], inverse: readonly Patch[]): void {
  expect(applyPatches(base, patches)).toBe(next);
  expect(applyPatches(next, inverse)).toBe(base);
}
