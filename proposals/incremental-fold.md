# Proposal: fold a draft's edits permanently, and unfold what changes

Status: proposal, 2026-09-30. Not decided. Touches D36 (drafts bound per
location, the aliasing doctrine), D47 (a draft stands for its current value
where a value is required), D53, D58 and D59 (the drafts' what-if reads).
Nothing here changes what a recipe means; it changes what a mid-recipe
whole-value read costs.

## 1. The problem

Inside a recipe, a collection draft is cheap to edit and cheap to read at a
key, and expensive to look at whole. The expensive operations are exactly
those that must hand back the canonical value the draft would be right now:

- `current(draft)`;
- `toJSON()`, and so `JSON.stringify` of anything holding the draft;
- the copying edits a draft has as what-ifs since D59, `d.m.with(k, v)`,
  `d.todos.pushed(x)`, and the rest;
- the other value-returning reads, `slice`, `concat`, `toSorted`, `union`,
  `keyList`, `valueList`;
- a draft used where a value is required, as a set member, a map key, an
  argument to `intern`, `deepHash` or a memoized function, or as the base of
  a nested `produce` (D47).

Each of them calls `snapshotOf(draft)`, and for the map, the ordered map
and the list the snapshot is a **fold**: the working value with every
pending edit applied. `withEdits` in `draft-map.ts` walks the overlay and
does `result = result.with(k, v)` per entry; `snapshotList` in
`draft-list.ts` does one `_setMany` over the overlay and one splice for the
tail. Every step is a persistent insert into a hash-consed trie: a path of
two or three 32-wide nodes copied and rehashed. BENCHMARKS.md prices one at
2.6–2.8 µs on Node and about 1.5 µs on Bun for a 10k map.

Measured during the review of PR #74, on 10k elements, per call:

| Pending edits | `DraftList.pushed` | `DraftMap.with` | the value's own `pushed` |
| --- | --- | --- | --- |
| 0 | 3.7 µs | — | ~2 µs |
| 1000 | 364 µs | 1.1 ms | 2.5 µs |

Nothing is cached, so a loop of m whole-value reads over a draft carrying
k pending edits costs O(m · k log n). The draft's own operations are not
the problem: `set` is an overlay write, `get` and `has` are one lookup,
`delete` of a base key is one persistent removal, iteration is O(n) as it
must be. Finalize pays the same fold once, which is the cost of producing
the value and is not what this proposal reduces.

The recipe idiom the guide recommends, edit through the verbs and let
finalize fold once, never hits this. What hits it is asking for the whole
value repeatedly mid-recipe: what-ifs in a loop, `current()` per iteration,
logging the draft, a draft handed to a memoized selector every step.

## 2. Goals and non-goals

Goals:

- A whole-value read of a draft that has not changed since the last one is
  O(1), and after an edit it costs in proportion to what changed, not to
  everything pending.
- Writes stay O(1) (plus the upward walk `markChanged` already does).
- The aliasing doctrine stands: raw material assigned into a draft stays
  raw and live until finalize, and a later write to it, directly on the
  object, still reaches the result.
- Patches stay exact and finalize stays correct for aliased and detached
  drafts.
- Third-party draftables written against `valsem/draft` keep working
  unchanged, and can opt into the incremental behaviour.

Non-goals:

- Making a single fold cheaper. That is the batch fold of §8, a separate
  and complementary change.
- Making raw material observable. Raw objects are never proxied; that is
  the immer rule valsem keeps ("raw material the recipe just made is
  handed back bare").

## 3. Terms

- **Fold**: applying an overlay entry's current value to the working
  value, `work = work.with(k, snapshotOf(entry))` for a map. A **folded**
  entry is one whose current value `work` already holds; an **unfolded**
  one is pending.
- **Holder**: a `(state, slot)` pair naming a place that holds a draft.
  Today a draft knows one holder, its `parent`, and not the slot.
- **Raw**: material that is neither a draft nor immutable, `stateOf(v) ===
  undefined && !isImmutable(v)`: the recipe's own unfrozen objects and
  arrays, assigned or pushed in and handed back bare.
- **rawBelow**: the number of raw entries in a state's subtree, itself
  included.

## 4. The design

### 4.1 `work` holds everything folded so far

For `DraftMap`, `work` today is the base with every delete applied and
nothing else: values live in the overlay, and a new key is deliberately
not written through, because a placeholder would be a path copy paid twice
(measured, sets of new keys +60 %). Under this proposal `work` holds, in
addition, every overlay entry that has been folded, at the value it had
when it was folded. The overlay stays the source of truth for reads: `get`
returns the child draft or the raw object from the overlay, never the
folded canonical, exactly as now.

Each overlay entry gains a `folded` flag, and the state keeps the set of
unfolded keys so that a fold is O(unfolded), not O(entries). A snapshot is:

    for each unfolded key k:  work = work.with(k, snapshotOf(edits.get(k).v)); mark folded
    verify raw material (§4.4)
    return work

`DraftOrderedMap` is the same with one difference already in place: its
`work` holds every key, new ones as placeholders, so a fold writes values
only. `DraftList` folds the unfolded overlay indices with `_setMany` and
flushes the tail as one splice, after which the tail is empty and every
entry is folded; `set(i, v)` and a child edit at index i unfold index i.
`DraftSet` and `DraftOrderedSet` already apply every edit to `work` as it
happens and hold members as values, never drafts, so their snapshot is
`work` and nothing changes for them.

A record or array proxy keeps its shadow copy as today and gains a cached
canonical: the interned snapshot, kept while no field is unfolded. A fold
of a record is O(width) whatever happens, since a canonical record is a
fresh object hashed over all its fields; what the cache buys is O(1) on
the repeated read, and it is invalidated by the same unfold walk as the
collections.

### 4.2 Unfolding: `markChanged` carries the slot and always propagates

Every draft already notifies its parent of a change: each kind calls
`markChanged(state)` on every changing edit, the record proxy's set trap
included (`produce.ts`, right after its no-op check), and a kind has to,
because `modified` is what lets an untouched draft finalize to its base in
O(1). So no new protocol is needed on the drafts themselves. The change is
inside `markChanged`:

    markChanged(state):
      state.modified = true
      for each holder (H, slot) of state:
        if entry (H, slot) is unfolded: continue        // the invariant covers everything above
        mark (H, slot) unfolded; H.unfolded.add(slot)
        markChanged(H)

The walk stops at the first holder edge already unfolded, as it stops
today at the first ancestor already modified, because of one invariant:

> If any entry of a state is unfolded, that state is unfolded in each of
> its holders.

Marking maintains it, since the walk marks upward until it meets an edge
already unfolded, above which the invariant already holds. A fold at a
state clears that state's own entries' flags, which only removes premises,
and leaves the state's status in its holders untouched: the state's content
still differs from what its holders folded. A fold at a holder folds the
state (recursively, through `snapshotOf`) and then clears the holder's
entries. Under the invariant a fold at any node visits exactly the
unfolded entries in its subtree, and a repeated read with nothing changed
in between visits none.

Termination: each edge is marked unfolded at most once between two folds,
so the walk ends even on a cyclic draft graph (`d.a.b = d`), which finalize
rejects anyway as a cyclic value.

### 4.3 Slots and holders

A state gains `holders: { state, slot }[]` in place of the single
`parent`; `parent` stays as the first holder for everything that uses it
today (`assertAssignable`, patch paths, finalize's `childPath`).

- `createChildDraft(value, parent)` gains the slot: the map passes the
  canonical key, the list its index, the record proxy its property key.
- Every assignment of a draft into another draft passes through
  `assertAssignable(value, into)`, which sees both states; it adds
  `(into, slot)` to the value's holders. This covers `d.x.b = d.y.a`, where
  the child then lives in two slots and must unfold in both, and it covers
  detached drafts from `draftOf`, which have no holder until attached and
  gain one per attachment.
- Removal or overwrite of an entry removes the holder record. A missed
  removal is never a wrong answer, only wasted work: unfolding a slot that
  no longer holds the child makes the next fold recompute that slot from
  the overlay's current content, which is correct by construction.
- Lists move their children: a splice re-indexes the overlay, and that loop,
  which already touches every moved entry, updates the holder record of
  each moved child. `flushTail` does the same for tail entries that enter
  the overlay.

### 4.4 Raw material is verified, not trusted

A raw object assigned into a draft can be written to afterwards, directly,
and by the aliasing doctrine that write reaches the result. No notification
can see it. So raw material is never treated as folded for good: a fold
writes its interned value into `work` like anything else, but every use of
`work` re-verifies it:

    for each raw entry (k, obj) of this state:
      v = intern(obj)                         // a pool lookup when unchanged
      if work.get(k) !== v: work = work.with(k, v)

`intern` of an unchanged raw object hashes it and finds the pooled
instance, about 300 ns for a small record, and identity decides the
comparison since both sides are canonical. A change costs one insert.

Rawness is transitive. A child draft that holds raw material can change
without notifying anyone, so its holder's folded value for it can be stale
even though the child is a draft. Each state therefore keeps `rawBelow`,
maintained by deltas along the same holder walk: +1 when raw material is
assigned or pushed in, −1 when the entry is removed or overwritten, and a
child's delta propagates to its holders. On use, after folding its unfolded
entries, a state re-folds every child entry whose state has `rawBelow > 0`,
which recurses only into those subtrees and only to their raw entries. The
child's snapshot is compared by identity with the folded value, and
re-inserted only if it differs.

The cost of a whole-value use is then, per pending entry:

| Entry holds | Cost per whole-value use |
| --- | --- |
| a primitive, or a canonical value assigned | nothing after the first fold |
| a child draft | one insert per level, for each change since the last use |
| a raw object | one intern per use, and an insert only if it changed |

How much the design delivers depends on reducer style. `d.m.get(id).visits++`
edits through a child draft: repeated reads become O(1). `d.m.set(id, { ...e,
visits: e.visits + 1 })` assigns a raw literal: every use re-interns it, so
a thousand of them cost about 0.3 ms per use against 1.1 ms today, a real
gain but not a constant. A survey of what a typical recipe's pending
material is made of would settle how much this matters; see §9.

### 4.5 Bookkeeping in `DraftMap`

A folded new key enters `work`, so `added`, the count of overlay keys not
in `work` that makes `size` O(1), is decremented when such a key is folded.
`size = work.size + added` still holds, with `added` now counting unfolded
new keys only. `has` is unchanged. `delete` of a folded new key takes the
"in `work`" branch, which already removes the overlay entry too. `clear`
resets everything, folded or not. `set` on a folded key marks it unfolded
and leaves `added` alone, since `work` counts it.

### 4.6 Finalize

Finalize reuses `work` for the trie: it folds the unfolded entries and
verifies raw material as a snapshot does, and for a folded, unchanged child
`resolve` returns the same canonical the fold wrote, so `work.with(k, v)`
returns `this` after a lookup. What finalize must still do for every child
draft entry, folded or not, is call `resolve`: that is where a child's own
patches are emitted under `path + key`, and where the memoization lives
that makes an aliased draft finalize once and its second slot come out as a
`replace` patch. So finalize's trie work shrinks to the unfolded entries
and its walk stays O(k) in `resolve` calls. Map patches come from the diff
of base and result, unchanged; list patches come from the op log and the
resolved slot values, unchanged.

### 4.7 Third-party draftables

A kind built with `createDraftState` needs no change to keep working: it
calls `markChanged` on edits already, and a kind that does not implement
the new optional `unfold(state, slot)` hook is treated as having no
incremental snapshot, so a notification marks the whole state stale and
its `snapshot` recomputes from scratch, which is today's behaviour. To
opt in, a kind passes the slot when it creates child drafts, implements
`unfold` to mark that slot pending, and makes its `snapshot` fold only what
is pending and verify its raw entries. The `valsem/draft` documentation
gains one paragraph and the toolkit two optional fields.

## 5. Cost model

For a draft with n entries, k pending edits, depth d from the root, and r
raw entries in the subtree:

| Operation | Today | Proposed |
| --- | --- | --- |
| `set`, `push`, `delete` of an added key | O(1) + intern of the key | the same, plus the holder walk, at most d steps and usually one |
| `get`, `has`, `size` | O(1) or one trie lookup | unchanged |
| iteration | O(n) | unchanged |
| first whole-value read | O(k log n) | O(k log n) + r interns |
| repeated read, nothing changed | O(k log n) | O(1) + r interns |
| read after one child edit | O(k log n) | O(d log n) + r interns |
| finalize | O(k log n) trie work, O(k) resolves | O(unfolded · log n) trie work, O(k) resolves, r interns |

With the measured 1000-edit case: primitives pending, 1.1 ms becomes about
3 µs on the repeated read; raw records pending, about 0.3 ms.

## 6. Correctness, and the law to test

The property is one sentence: after any sequence of edits through drafts,
raw assignments, direct writes to raw objects, aliasing (`d.x.b = d.y.a`),
detaching and attaching (`draftOf`), deletes, clears, and whole-value reads
at any node in any order, the incremental fold at every node equals a fold
from scratch, and `produce` returns what it returns today, with the same
patches.

The test is a model-based property over the roster, in the style of
`property-produce.test.ts`: a random program of those operations run twice,
once against the incremental drafts and once against a from-scratch
snapshot computed by walking the overlay, with `current()` compared at
random points and the final value and patches compared at the end. The
existing suites, `produce-corpus`, `property-patch-laws`, `draft-edges`,
`free-draft`, are the regression net; the raw-material cases (`d.m.set(k,
obj); current(d.m); obj.x = 2; current(d.m)`) and the aliasing cases are
the new ones to pin.

## 7. Alternatives considered

- **A cache cleared on any change.** Simpler, and useless for the
  interleaved pattern (edit, read, edit, read), since every read re-folds
  everything; it has the same raw-material and aliasing problems without
  the incremental payoff.
- **Eager application, `DraftSet`'s model, for the maps and the list.**
  Every `set` becomes a persistent insert. Measured when `DraftMap` was
  redesigned: +60 % on sets of new keys, and child drafts still need
  folding at the end. Rejected then for the common path; the proposal keeps
  writes O(1).
- **Adopting raw material at assignment.** Intern on `set`, so nothing raw
  is ever pending and every entry folds for good. O(1) whole-value reads
  regardless of reducer style, at the price of the aliasing doctrine:
  `d.a = obj; obj.x = 1` would no longer reach the result, which it does
  in immer and in valsem today, and adoption would freeze the recipe's own
  object in its hands. This is a decision for DECISIONS.md beside D36, not
  an implementation detail; the proposal is written for verification so
  that it stands either way.
- **Freezing raw material at the first fold.** Makes a later write loud
  instead of stale, but only if a snapshot happened in between, a
  timing-dependent semantics, and silent under `skipFreezing()`. Rejected.
- **Proxying raw material on assignment.** Would make it observable and
  break the identity the aliasing doctrine relies on (`d.m.set(k, obj);
  d.m.get(k) === obj`). Rejected.

## 8. The batch fold, first

Independently of everything above, the fold itself is k independent
persistent inserts, each copying its own path. The trie counterpart of
`ValueList._setMany`, applying k edits in one bottom-up pass so that each
touched leaf and shared ancestor is rebuilt once, cuts the constant of
every fold: every snapshot read, every what-if, and finalize, which this
proposal does not otherwise reduce. `ValueMap.from` builds 10k entries from
scratch in 1.9 ms, so a thousand batched edits into an existing trie should
land well under the current millisecond. It has no invalidation problem, no
doctrine question and no new invariants, and it should be built and
measured before this proposal, because it may make the common cases cheap
enough that only the repeated-read pattern remains, which is exactly what
this proposal is for.

## 9. Plan, and what to measure first

1. Measure what a typical recipe's pending material is made of: primitives,
   child drafts, raw literals. The soak worker's valsem variant and the
   produce benchmarks are the places to instrument. This number decides
   whether §4.4's verification cost is a footnote or the whole story.
2. The batch fold for the HAMT (§8), with its own benchmark rows.
3. Holders and slots in `draft-core` and the two proxies, with the holder
   bookkeeping tested on aliasing, detaching and list re-indexing; no
   behaviour change yet.
4. `DraftMap`: unfolded set, permanent fold, raw verification, `added`
   bookkeeping; the §6 property test; benchmark rows for repeated
   `current()` and what-ifs at 0, 10, 1000 pending edits.
5. `DraftList` and `DraftOrderedMap` the same way.
6. The record and array proxies' cached canonical.
7. Docs: the produce guide's cost statements, the `valsem/draft` toolkit
   page, and a DECISIONS entry recording the raw-material rule.

## 10. Open questions

- Verify or adopt raw material (§4.4, §7)? Verification keeps the
  doctrine and pays per raw entry per use; adoption changes an
  immer-visible behaviour and pays nothing later.
- Should `rawBelow` be tracked at all, or should a state with any raw
  entry below simply be re-folded whole on use? Tracking is a counter
  maintained on every raw assignment and removal; the simpler rule costs a
  full fold for a subtree that has one raw entry somewhere.
- Is the `unfold` hook the right shape for third-party kinds, or should
  the core own the unfolded set and the kinds only expose their fold?
