<script setup>
import { defineClientComponent } from 'vitepress';
// The demo touches the intern pool at module scope, so load it client-only.
const UndoTreeDemo = defineClientComponent(() => import('./.vitepress/components/UndoTreeDemo.vue'));
</script>

# The undo-tree demo

A tiny document editor whose entire history is a graph of **canonical
states**. Every edit runs through `produce`; every state the document has ever
been in is one interned value; the history index is a plain identity `Map`
keyed by state objects — because equal states *are* the same object.

<UndoTreeDemo />

## What to watch for

**Revisits allocate nothing.** Toggle a todo twice, or toggle the theme back
and forth. The second edit reaches a state the document has already been in —
`produce` returns the *existing* canonical object, the identity map finds its
node, and the history gains no entry. Libraries with reference identity grow
their history by one node per edit forever; here history is bounded by the
number of **distinct** states, and the "revisits" counter is literally
counting `===` hits.

**Net no-ops converge on the base.** "Clear done" with nothing checked, and
`produce` hands back the canonical base itself — the flash message reports the
pointer equality.

**The dirty check is one pointer compare.** The saved/unsaved badge is
`current.state !== saved` — no deep comparison, no version counters, no dirty
flags to maintain, at any document size.

**Structural sharing spans the whole graph.** Undo, branch off in a new
direction, and both branches still share every unchanged subtree — sharing
follows content, not lineage.

## The whole trick

```ts
const byState = new Map<State, HNode>(); // identity map ⟺ structural map

function apply(label: string, recipe: (d: Draft<State>) => void) {
  const next = produce(current.state, recipe);
  if (next === current.state) return;         // netted out — not an edit
  const existing = byState.get(next);         // been here before?
  if (existing) { current = existing; return; } // …then just move the pointer
  const node = { id: nodes.length, state: next, label, parent: current, children: [] };
  current.children.push(node);
  byState.set(next, node);
  current = node;
}
```

There is no equality logic, no serialization, no hashing code in the demo —
`Map` and `===` do structural work because the states are canonical. That is
the library's thesis in one function.
