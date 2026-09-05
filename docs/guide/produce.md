# produce: mutate a draft, get the canonical value

`produce` gives you plain mutable syntax over immutable values — the immer
ergonomics — with one upgrade: the result is **canonical**. `intern` is the
degenerate case: `produce(base, () => {}) === intern(base)`, and edits that
net out structurally converge back to the canonical base for free.

```ts
import { produce, intern, ValueList } from 'valsem';

const state = intern({ count: 1, todos: ValueList.of('a') });
const next = produce(state, (draft) => {
  draft.count++;
  draft.todos.push('b');       // ValueList slots draft as a DraftList
});

next === intern({ count: 2, todos: ValueList.of('a', 'b') });     // true — canonical
next.todos === produce(state, (d) => void d.todos.push('b')).todos; // lineage-free
```

Plain objects and arrays draft through proxies (any syntax works, including
array methods); `ValueMap`/`ValueSet`/`ValueList` slots hand out
`DraftMap`/`DraftSet`/`DraftList` — mutable twins with the native-collection
API. Raw material assigned into a draft is **adopted**: interned on the way
into the result, exactly like the collections' intern-on-entry. Drafts are
revoked when `produce` returns — using a leaked draft throws.

## Semantic patches

`produceWithPatches` additionally returns **semantic patches** (and their
inverses): net `record.set`/`record.delete`, `map.set`/`map.delete`,
`set.add`/`set.delete` — and for sequences, *recorded* `list.splice` intent
rather than index diffs (a `DraftList.splice` is one patch, not n). Apply them
with `applyPatches`; because everything is canonical,
`applyPatches(base, patches) === produce(base, recipe)` — patch streams and
direct production converge on the same instance.

```ts
const [next2, patches, inverse] = produceWithPatches(state, (d) => {
  d.todos.splice(0, 1, 'z');
});
applyPatches(state, patches) === next2;   // true
applyPatches(next2, inverse) === state;   // true
```

A recipe whose edits net out to the base emits **no patches at all** — patch
streams are as canonical as results.

## Recipe conventions

Recipes follow the immer conventions: mutate the draft, or return a
replacement value (`nothing` for "the result is `undefined`") — never both.
The curried form `produce(recipe)` returns `(base, ...args) => produce(base,
(d) => recipe(d, ...args))`.

Recipes must be **synchronous** — an `async` recipe returns a Promise, which
is not a value, and is rejected with a teaching error. Await your data first,
then produce.

## Looking at a draft: `current()` and `original()`

immer's two inspectors, with valsem's guarantee attached. `original(draft)`
is the value the draft was made from; `current(draft)` is the **canonical**
value of what the draft holds right now — exactly what `produce` would
return if the recipe ended here — and the draft stays live afterwards.
Both work on any draft: plain objects and arrays, `DraftMap`/`DraftSet`/
`DraftList`, and your own draftables.

```ts
import { produce, current, original } from 'valsem';

const next = produce(doc, (d) => {
  d.text += '!';
  d.history.push(current(d).text);   // a canonical snapshot — safe to store, cheap to adopt
  original(d.history) === doc.history; // true
  d.text += '?';                      // still editing
});
```

An unmodified draft snapshots to its base in O(1); a modified container is
copied and hashed, so `current()` in a hot loop costs what a produce costs.
Both throw outside the recipe, like any other use of an escaped draft.
`Undraft<D>` is their return type — the inverse of `Draft<T>`.

## Identity in a draft: the aliasing doctrine

Inside a recipe you are writing plain mutable JavaScript, and valsem preserves
plain-JS aliasing exactly as far as identity actually exists:

- **Your own (unfrozen) objects alias.** Push one object into two slots and
  mutate it — both slots see the change, like anywhere else in JavaScript.
  ```ts
  produce(intern({ arr: [1, 2, 3] }), (d) => {
    (d.arr as unknown[]).fill({ x: 0 }, 1); // ONE object in slots 1 and 2
    (d.arr[1] as { x: number }).x = 5;      // …so both become { x: 5 }
  });
  ```
- **Canonical (frozen) values copy-on-write per slot.** Assigning a canonical
  into the draft (`d.c = base.b`) and mutating through the read works — the
  read hands you a draft over it, and the canonical is never touched. When an
  operation like `copyWithin` duplicates a canonical into several slots,
  mutating one slot changes *that slot only*: canonicalization collapses equal
  objects (`intern([{ x: 1 }, { x: 1 }])` stores **one** object in both
  positions), so "reference aliasing" of canonicals is not representable —
  identity exists only where mutability does.

This is also why results are safe: a recipe can never mutate a canonical base,
relocated or not — sort, reverse, shift, splice included.
