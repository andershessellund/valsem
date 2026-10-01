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
`DraftMap`/`DraftSet`/`DraftList` (and `OrderedMap`/`OrderedSet` slots
`DraftOrderedMap`/`DraftOrderedSet`) — mutable twins with the native-collection
API: a draft has every method of its value. What edits, edits the draft in
place; what does not (`slice`, `concat`, the set algebra) answers about the
value the draft would be right now, as `current(draft)` would, and returns a
value, not a draft (`toArray` included). The value's own copying edits —
`with`, `pushed`, `added`, `deleted`, … — are among what does not edit: on a
draft they are what-ifs, the value the edit would give. In a recipe, prefer
the verbs, for two reasons. An assigned what-if is a snapshot:
`d.todos = castDraft(d.todos.pushed(x))` puts a value in the slot, so a child
draft handed out earlier (`const first = d.todos.get(0)`) and a draft passed
as the argument are cut off, and a later `first.done = true` goes nowhere,
where `d.todos.push(x)` keeps them live. And the patch is a whole-slot
replacement, where `push` records one `list.splice`. A what-if also builds
the snapshot on every call, so in a loop take `current(d.todos)` once.
Iterating a `DraftList`, a `DraftMap`
or a `DraftOrderedMap` (`for…of`, `forEach`, `values()`, `entries()`) hands
out drafts, as `get` does, so `for (const t of d.todos) t.done = true` edits,
the same as on a plain array; keys, and the members of a set, come as the
values they are. So do the removal verbs: `pop`, `shift`, `splice` and the
list's `remove` hand back what they removed drafted, as `get` would have
handed it out, so the immer idiom `const t = d.todos.shift(); t.done = true;
d.done.push(t)` edits, on a plain array and a `DraftList` alike (the recipe's
own raw material comes back raw, as a read of it does); and `sort`,
`reverse`, `fill` and `copyWithin` on a plain array return the draft, as
`Array`'s return `this`, so `d.todos.sort(byId)[0].done = true` edits too
(`splice` hands its removed elements out through a proxy that drafts each
on first read, so clearing a list with `splice(0)` drafts nothing). A
walk is a native one: an entry deleted before the walk reaches it is not
visited, one added during the walk is (a `DraftMap` visits the added keys
after the base's; the ordered drafts and a `DraftSet` visit them where a
native `Map` or `Set` would), and a `DraftList`'s `for…of` is live by index
where its `forEach` reads the length once, as `Array`'s do. A set holds its members by content, so there is no editing
one in place: changing a member is removing it and adding another, which may
already be there. Say so: for every member,
`d.tags = castDraft(d.tags.map((t) => ({ ...t, n: 0 })))`, where two members
that become equal are one member, as `map` on a set always gives; for one,
`d.tags.delete(t); d.tags.add({ ...t, n: 0 })`. In a loop, walk a copy
(`for (const t of [...d.tags])`): a member added to the set being walked is
visited too, as on a native `Set`, and a loop that replaces what it visits
with a changed member does not end. Going in, it is the same rule from the other side: where a
value is required (a set member, a map key, an argument to `intern` or a
memoized function), a draft stands for the value it holds right now, as
`current(draft)` would give it. So `d.seen.add(t); t.done = true` leaves the
set holding `t` as it was, where a list slot given the same draft follows it
to the end of the recipe. Finish the edit, then add. Records you mean to edit in place have an id, and belong in a map
keyed by it. A draft costs about 0.3 µs, so a loop that only reads a
large collection is cheaper over `current(d.todos)` or `d.todos.slice()`,
which draft nothing, and so are the functional reads: `map`, `filter`,
`reduce`, `some`, `every` and `findIndex` on a draft show their callback
values (a drafted child as it is right now) and give back values. `find` is
the one that hands out a draft, the hit, so
`d.todos.find((t) => t.id === id)!.done = true` edits and drafts one element.
Raw material assigned into a draft is **adopted**: interned on the way
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
The patches are frozen like everything else `produce` returns: the two lists,
each patch, its `path`. To build up a history, collect them into a list of
your own (`history.push(...patches)`).

```ts
const [next2, patches, inverse] = produceWithPatches(state, (d) => {
  d.todos.splice(0, 1, 'z');
});
applyPatches(state, patches) === next2;   // true
applyPatches(next2, inverse) === state;   // true
```

A recipe whose edits net out to the base emits **no patches at all** — patch
streams are as canonical as results. A patch holds what was inserted, as a
value, so a non-value that passes through a sequence during the recipe (a
`Date` pushed, then removed again) is tolerated by `produce`, which never
looks at it, and refused by `produceWithPatches`, which would have to record
it. `applyPatches` validates what it is
given: a path is followed only through own keys and in-range indices (a
segment like `__proto__` throws), keys and indices are type-checked, and
patch values are interned on application — so patches can come off a wire,
and `applyPatches` never writes into the values you hand it.

Most patches are the fine-grained operations above. A `replace` patch means
"the value at this path becomes that": at the root when a recipe returned a
replacement, and below it in one situation, when the same edited draft was
placed in several slots (`d.b = d.a`), where one of them is described whole.

Record patches carry the key as written, so a symbol-keyed edit yields a
patch with a symbol `key` (or a symbol in its `path`). Those apply and invert
in-process like any other, and, like immer's, they are not serialisable.

## Recipe conventions

Recipes follow the immer conventions: mutate the draft, or return a
replacement value (`nothing` for "the result is `undefined`") — never both.
The typing is immer's too: a recipe returns the state's type, its draft, or
nothing, and `nothing` only where the state type admits `undefined`
(`produce<State | undefined>(state, () => nothing)`). The curried form
`produce(recipe)` returns `(base, ...args) => produce(base, (d) => recipe(d,
...args))`, with the extra arguments typed from the recipe. Name the state
either way, as with immer — an explicit type argument, or an annotated draft
parameter from which the state is recovered:

```ts
const toggle  = produce<Todo>((d) => { d.done = !d.done; });
const setDone = produce((d: Draft<Todo>, done: boolean) => { d.done = done; });
const rename  = produce<Todo, [string]>((d, text) => { d.text = text; });
setDone(todo, true);
```

**What gets drafted.** Plain objects and arrays, and anything implementing
`[toDraft]`. Everything else — `ValueDate`, `InternedString`, `RawArray`,
Temporal values, your own `[equals]`/`[hashCode]` classes — is an **opaque
leaf**: the recipe receives the canonical value itself, its methods work,
its fields are exactly as the class declares them (`Draft<ValueDate>` is
`ValueDate` — declare a value type's fields `readonly`, since a write through
the draft would reach the pooled instance), and you change it by assigning a
new value into its slot: `d.at = ValueDate.from(later)`. A
draft earns its keep only for a container, where in-place edits are cheaper
than rebuilding or a patch can carry intent that replacement loses; a leaf
gains nothing from one.

The type system recognises a leaf by its methods — a record can never hold a
function, so a type with one is a class instance. The one case it cannot see
is a class registered with `deepEqual.register` that has **no methods at
all**: `Draft<T>` maps it member-wise and writable, while at runtime the
recipe receives the pooled instance, unfrozen, so a write through it would
corrupt every holder — and `produce` cannot notice, since the leaf is not a
draft. Give such a class a method (a `toJSON`, a `with`; an accessor does not
count, it is a property to the type system), or use the
`[equals]`/`[hashCode]` form, before it goes into drafted state.

**Assigning a whole collection.** A recipe may put a value wherever a draft
is: `d.todos = ValueList.of(a, b)` works, and the value is adopted on the way
out. TypeScript objects, though, because `Draft<T>` types that slot as a
`DraftList` and a property cannot have a wider type for writing than for
reading. `castDraft` says what you mean, and does nothing at runtime:

```ts
import { castDraft, produce } from 'valsem';

produce(state, (d) => {
  d.todos = castDraft(fetched.todos);         // replace the list with the one from the server
  d.tags = castDraft(d.tags.union(moreTags)); // a draft's algebra returns a value
});
```

Recipes must be **synchronous** — an `async` recipe returns a Promise, which
is not a value, and is rejected with a teaching error. Await your data first,
then produce.

**Positions are checked.** The collection drafts follow their values:
`d.list.get(i)` and `set(i, v)` name an element that must exist (`at(i)` is
`Array`'s: from the end when negative, `undefined` for no element, and a
draft where `get` gives one, so `d.list.at(-1)!.done = true` edits), `d.list.splice(start, count)` takes a `start` in
`[0, length]` and a count that means "up to", and anything else is a
`RangeError` (see [the collections guide](./collections)). A plain array in
a recipe is an `Array`, and its reads and its bounds are the native ones;
the mutators valsem records as intent (`splice`, `fill`, `copyWithin`) add
one check, that their index arguments are integers, where `Array` would
coerce a `NaN` to index 0. The check runs before anything is touched, so
nothing is half-done when it throws. So every call `Array` would have
coerced throws here, a required position that is missing included:
`splice()`, `splice(undefined)` and `copyWithin(undefined, 1)` are `RangeError`s
where `Array` reads the `undefined` as 0. A count left out means "the rest",
as it does to `Array`; a count passed as an explicit `undefined` is refused
everywhere, on a plain array draft, a `DraftList` and a `ValueList` alike,
where `Array` reads it as 0 (and would delete nothing before items): leave
it out, or pass `Infinity` for the rest. On a `DraftList` and a `ValueList`
TypeScript refuses it as well, by the overloads of `splice` and `toSpliced`;
a plain array's `splice` is typed by the standard library, so there only the
runtime check applies.

Patches are exact for the same reason: `applyPatches` refuses a `list.set`
or `list.splice` whose index or count does not fit the value, because a
patch that does not fit was made against another base.

## Calling a producer from inside a recipe

A function built on `produce` works inside someone else's recipe as it does
anywhere: a draft given to `produce` as its **base** stands for the value it
is right now, so `produce(draft, recipe)` is `produce(current(draft), recipe)`,
for every kind of draft.

```ts
const bump = (c: Counter): Counter => produce(c, (d) => { d.n++; });

produce(state, (d) => {
  d.counter = bump(d.counter);   // bump neither knows nor cares that it was handed a draft
});
```

It takes a value, returns a value, and edits nothing, so the caller has to
**use the result**, exactly as with `list.pushed(x)` on a `ValueList`; calling
`bump(d.counter)` and dropping what it returns changes nothing. That also
means a what-if can be asked twice (`bump(d.counter)` is the same value both
times), and the result outlives the recipe. `produceWithPatches` and
`applyPatches` take a draft the same way, with patches relative to the value
it is right now. When the state holds collections, TypeScript will not take
a `Draft<Sub>` where a `Sub` is declared (a `DraftList` is not a
`ValueList`): write `step(current(d.sub))`, and `castDraft` to assign the
result.

## Looking at a draft: `current()` and `original()`

immer's two inspectors, with valsem's guarantee attached. `original(draft)`
is the value the draft was made from (a raw input's canonical: `produce`
interns its input before drafting it); `current(draft)` is the **canonical**
value of what the draft holds right now — exactly what `produce` would
return if the recipe ended here — and the draft stays live afterwards.
Both work on any draft: plain objects and arrays, the collection drafts
(`DraftMap`, `DraftSet`, `DraftList`, `DraftOrderedMap`, `DraftOrderedSet`),
and your own draftables.

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

## Editing material from elsewhere: `draftOf()`

A recipe often brings in a value that is not reachable through its draft —
another store's state, a signal read inside a `computed`, a fetched record —
and wants to edit it before it has a slot. `draftOf(value)` hands out a
**detached** draft: a second root in the same recipe, with no location yet.
Edit it, then attach it anywhere — assign it, push it, set it into a
collection, embed it in a literal, return it as the replacement — and it
resolves to its canonical value where it landed. Attached at several places,
every place receives the same instance. Never attached, it is dropped.

```ts
import { produce, draftOf } from 'valsem';

const view = computed(() =>
  produce(state(), (d) => {
    const cfg = draftOf(settings());     // a canonical from another signal
    cfg.enabled = flags().has('beta'); // edit before it has a slot
    d.config = cfg;                    // attach; finalize resolves it here
  }),
);
```

Material already reachable through the draft needs no `draftOf()`: reads hand
out child drafts, and an assigned canonical is drafted on read-back (`d.c =
other; d.c.x = 1` works). `draftOf(x)` and `d.k` with `base.k === x` are two
independent states over one base — edits to one do not appear in the other.
A detached draft is revoked with the recipe like every other draft, throws
outside one, and attaches as a whole-value patch (a `record.set`, a
`list.splice`, …), the same as any graft. Non-draftables return themselves,
and a draft of the running recipe returns itself.

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

This is also why inputs are safe. `produce` **never modifies its input**,
through any path: the base is interned before it is drafted, so every object
a recipe can reach from the draft is frozen, and a write that bypasses the
drafts — a `sort` comparator writing into its arguments, a property
descriptor's `value`, `original(d)` — throws instead of landing in the
caller's object. A raw input costs the intern walk, which finalize would have
made anyway; a canonical input costs one cache probe. The one consequence to
know: a non-value anywhere in a raw input (a `Date`) is rejected before the
recipe runs, even where the recipe would have deleted it.
