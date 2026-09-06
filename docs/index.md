---
layout: home

hero:
  name: valsem
  text: JavaScript values the way they should have been.
  tagline: 'Immutable, with immer''s ergonomics, compared by value — and fast where it counts: equal content is the same object, so comparing state is a pointer check at any size.'
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
  - title: Equality is ===
    details: intern() collapses every structurally-equal value to one frozen canonical instance. After that, value equality is a pointer compare — 20–33 ns at any size.
  - title: The immer ergonomics, canonical results
    details: produce() gives you plain mutable syntax over immutable values, and the result is canonical — edits that net out converge back to the very same base object.
  - title: Collections that dedup themselves
    details: ValueMap, ValueSet, and ValueList are hash-consed — equal content converges on the same tree nodes process-wide, however it was built. HashMap keys any cache by structure.
  - title: History for free
    details: Held versions share unchanged subtrees across the whole version graph, and revisited states are pointers to existing objects. An undo tree costs its unique content, not its edit count.
  - title: Extensible
    details: Your own classes become values with one method ([equals] + [hashCode]) or one registration; Temporal ships behind valsem/temporal. What cannot be a value — Date, Map, an unknown class — is rejected with an error that names the fix.
  - title: Hashing that respects equality
    details: deepHash is deepEqual's companion — equal implies same hash — seeded per process against hash flooding, cached on every canonical value.
  - title: Honest performance
    details: The benchmarks page publishes the losses first, with the methodology that produced them. The wins are the arenas frontends actually run.
---
