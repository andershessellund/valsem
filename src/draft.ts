// ---------------------------------------------------------------------------
// valsem/draft — the toolkit for making your own types draftable.
//
// `produce` drafts plain objects and arrays itself; everything else — the
// built-in ValueMap/ValueSet/ValueList included — arrives through the
// `[toDraft]` protocol and is built with what this module exports. Covered
// by semver like `valsem/binding`: additions are minor, removals are major.
//
// The recipe, in outline (see the "Bring your own draftable" guide):
//
//   class Interval {
//     [toDraft](parent?: DraftState): IntervalState {
//       const state = createDraftState<IntervalState>({ kind: 'interval', parent, base: this,
//         lo: this.lo, hi: this.hi, draft: null!, finalize: finalizeInterval });
//       state.draft = new IntervalDraft(state);
//       return state;
//     }
//   }
//
// with the draft calling `assertUnrevoked(state)` before every operation and
// `markChanged(state)` after every mutation, and `finalizeInterval` returning
// the canonical value (and pushing patches into the recorder when given a
// path).
// ---------------------------------------------------------------------------

export {
  toDraft,
  DRAFT_STATE,
  createDraftState,
  isDraftable,
  isDraft,
  stateOf,
  markChanged,
  assertUnrevoked,
  assertAssignable,
  createChildDraft,
  resolve,
  restoreValue,
  same,
  emitSeqOps,
  retractSeqPatches,
  seqTailProfile,
} from './draft-core.js';
export type { DraftState, Patch, PatchKinds, PatchPath, PatchRecorder, Scope, SeqOp } from './draft-core.js';
