// ---------------------------------------------------------------------------
// current() and original() — immer's two draft inspectors.
//
// `original(draft)` is the value the draft was made from; `current(draft)`
// is the canonical value of what the draft holds right now, nested drafts
// included, with the draft left live for the rest of the recipe. Both work
// on any draft: plain objects and arrays, the collections' drafts, and your
// own draftables (which supply `snapshot` on their draft state).
//
// Its own module on purpose: the two core snapshots register here, so a
// bundle that uses only `produce` carries none of this.
// ---------------------------------------------------------------------------

import {
  DRAFT_STATE,
  stateOf,
  snapshotOf,
  assertUnrevoked,
  _setCoreSnapshot,
  type DraftState,
} from './draft-core.js';
import { _snapshotCore } from './produce.js';
import { intern } from './intern.js';

_setCoreSnapshot(_snapshotCore);

/**
 * The value type a draft type stands for — the inverse of `Draft<T>`:
 * `Undraft<DraftMap<K, V>>` is `ValueMap<K, V>`, `Undraft<IntervalDraft>` is
 * `Interval` (read off the draft's `[DRAFT_STATE]`), and a plain object or
 * array draft maps back member-wise.
 */
export type Undraft<D> = D extends { readonly [DRAFT_STATE]: DraftState<infer B> }
  ? B
  : D extends readonly (infer U)[]
    ? Undraft<U>[]
    : D extends object
      ? { [P in keyof D]: Undraft<D[P]> }
      : D;

function stateOrThrow(draft: unknown, fn: string): DraftState {
  let state: DraftState | undefined;
  try {
    state = stateOf(draft);
  } catch {
    // A revoked Proxy throws on any trap — the plain object/array drafts
    // after their recipe. Same situation, same teaching error.
    assertUnrevoked({ revoked: true } as DraftState);
  }
  if (state === undefined) {
    const what = Array.isArray(draft)
      ? 'a plain array'
      : draft === null
        ? 'null'
        : typeof draft === 'object'
          ? 'an object'
          : `a ${typeof draft}`;
    throw new TypeError(`valsem: ${fn}() expects a draft, got ${what}`);
  }
  assertUnrevoked(state);
  return state;
}

/**
 * The value `draft` was made from — the base as it was passed to `produce`
 * (or held by the parent), untouched by the recipe.
 *
 * @throws TypeError if `draft` is not a draft.
 */
export function original<D>(draft: D): Undraft<D> {
  return stateOrThrow(draft, 'original').base as Undraft<D>;
}

/**
 * A canonical snapshot of `draft` as it stands now: exactly what `produce`
 * would return if the recipe ended here, nested drafts included. The draft
 * stays live — keep editing it, and drafts you hold of its children keep
 * flowing into the result. Unmodified drafts snapshot to their (interned)
 * base in O(1); modified containers are copied and hashed.
 *
 * @throws TypeError if `draft` is not a draft.
 */
export function current<D>(draft: D): Undraft<D> {
  stateOrThrow(draft, 'current');
  return intern(snapshotOf(draft)) as Undraft<D>;
}
