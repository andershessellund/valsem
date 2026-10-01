---
layout: home

hero:
  name: valsem
  text: JavaScript values the way they should have been.
  tagline: 'Immutable, with immer''s ergonomics, and compared by content: maps and sets keyed by what a thing is, equal values that are one object, and an error for anything that is not a value.'
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Try the undo-tree demo
      link: /demo
    - theme: alt
      text: Benchmarks
      link: /benchmarks

features:
  - title: Maps and sets that actually work
    details: HashMap and HashSet key by content, so a set of points holds no duplicates and a lookup hits on a key you rebuilt. ValueMap, ValueSet and ValueList are the immutable ones, with structural sharing, and equal content is the same object however it was built.
  - title: Equality is ===
    details: intern() collapses every structurally-equal value to one frozen canonical instance. A fresh object that equals last render's is last render's object, so effects, memos and caches see nothing new — and the compare is a pointer check at any size.
  - title: The immer ergonomics, canonical results
    details: produce() gives you plain mutable syntax over immutable values, and the result is canonical — edits that net out converge back to the very same base object.
  - title: Loud at the boundary
    details: A Date, a native Map or Set, an unknown class, an async recipe, a NaN index, a draft used after its recipe — each is an error that names the fix, never a silent wrong answer.
  - title: History for free
    details: Held versions share unchanged subtrees across the whole version graph, and revisited states are pointers to existing objects. An undo tree costs its unique content, not its edit count.
  - title: Extensible
    details: Your own classes become values with one method ([equals] + [hashCode]) or one registration; Temporal ships behind valsem/temporal. Hashing is deepEqual's companion — equal implies same hash — seeded per process against hash flooding.
  - title: Honest performance
    details: Comparing is a pointer check at any size; building costs more than a copy. The benchmarks page publishes the losses first, with the methodology that produced them.
---
