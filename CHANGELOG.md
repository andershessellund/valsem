# Changelog

## [0.1.0](https://github.com/andershessellund/valsem/compare/v0.0.4...v0.1.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* produce interns its input before drafting it, so it never modifies its input through any path; original() of a raw input is its canonical, and a non-value anywhere in a raw input is rejected before the recipe runs
* ValueSet.reduce and DraftSet.reduce require their initial value, as D54 says; OrderedSet's folds from the first member when none is given
* the value collections' edits are renamed for their result (D59). ValueList: push, pop, set, splice, insert, remove are now pushed, popped, with, toSpliced, inserted, removed; ValueMap: set, delete are with, deleted; ValueSet: add, delete are added, deleted; OrderedSet: add, delete, insertAt are added, deleted, insertedAt; OrderedMap: set, delete, insertAt are with, deleted, insertedAt. setMany is internal and DraftList.setMany is removed. The drafts keep the imperative verbs and gain every value method as a what-if; ValueList gains first, last, shifted and unshifted. An explicit undefined deleteCount is refused everywhere: DraftList.splice(i, undefined) and ValueList.toSpliced(i, undefined) throw where they meant "the rest" before, and the overloads make the call a type error; leave the count out, or pass Infinity. The compiler finds every call site, since drafts, HashMap and arrays keep the old names.
* at on OrderedSet, OrderedMap and their drafts counts a negative index from the end and returns undefined for an index that names nothing, where it threw. keyAt and valueAt are removed from OrderedMap and its draft. For a strict read use get on keyList or valueList.
* ValueDate.of is ValueDate.from
* fastEquals is fastEqual
* HashMap.getOrCreate is getOrInsertComputed, and getOrInsert joins it
* HashMap.getOrCreate is renamed getOrInsertComputed, the name Map.prototype has for it.
* for-of, forEach, values and entries on a list or map draft yield drafts, typed Draft<T>, where they yielded frozen values. Keys and set members are still values. DraftList.toArray returns the frozen canonical snapshot, not an array of drafts. To walk a draft without drafting, iterate current of the draft.
* ValueList.splice takes its items as rest arguments, no longer as one array. Spread the array at the call site. A splice with an undefined count followed by items now throws on ValueList and DraftList. Pass Infinity to remove through the end and insert.
* the two patch lists returned by produceWithPatches, each patch object, and its path and insert arrays are now frozen (unless skipFreezing() was called), and typed readonly. Code that pushed onto a returned list or edited a patch in place must copy first: history.push(...patches) still works, patches.push(x) throws.
* createInterner() is gone. It returned { intern } over the global pool, so replace createInterner().intern(x) with intern(x).
* on ValueList, OrderedMap, OrderedSet, RawArray and their drafts, get, at, keyAt, valueAt and remove now throw a RangeError for an index outside [0, length) where they returned undefined (or, for remove, did nothing or counted a negative index from the end), and their return types no longer include undefined; compare with length to probe. insert and the start of splice take an integer in [0, length] and no longer clamp or count from the end. slice, and the count of splice, still clamp as Array does. Every positional argument must be an integer: NaN, 1.5 and '2' throw where they were coerced, including in splice, fill and copyWithin on a plain array inside a recipe, where splice(i, undefined, x) throws as well. applyPatches refuses a list.set or list.splice whose index or count does not fit the value, and a sequence op aimed at a record.

### Features

* a draft has every method of its value ([#33](https://github.com/andershessellund/valsem/issues/33)) ([3490823](https://github.com/andershessellund/valsem/commit/3490823ad01b13fff33b4dda85f75a71b798d477))
* a position is checked: NaN, fractions, and an index that names no element throw ([b2b7c56](https://github.com/andershessellund/valsem/commit/b2b7c5661fe731eee521b9224e67a7c9b8407b57))
* a value's edits are named for their result; the imperative verbs are the drafts' ([2acaf98](https://github.com/andershessellund/valsem/commit/2acaf986351b83e8f5ba63ff1a8def6306b3a41b))
* at is Array.prototype.at, beside the strict get; keyAt and valueAt are removed ([508d8f2](https://github.com/andershessellund/valsem/commit/508d8f215434222c6c9bb5732f9920c8ed14ddff))
* castDraft, for assigning a value into a draft slot ([#35](https://github.com/andershessellund/valsem/issues/35)) ([5bd7fd5](https://github.com/andershessellund/valsem/commit/5bd7fd58237d79d6bd869a563b861841956ec62f))
* console.log sees the collections; util.inspect and Symbol.toStringTag on every collection and draft ([#34](https://github.com/andershessellund/valsem/issues/34)) ([7698414](https://github.com/andershessellund/valsem/commit/7698414b55408ec3f4845118fdb7eb5fceab5780))
* fastEquals is fastEqual ([111f9fc](https://github.com/andershessellund/valsem/commit/111f9fcfd39a8b8ee8f22e2c4088d8017aedb159))
* HashMap.getOrCreate is getOrInsertComputed, and getOrInsert joins it ([111f9fc](https://github.com/andershessellund/valsem/commit/111f9fcfd39a8b8ee8f22e2c4088d8017aedb159))
* iterating a DraftList, DraftMap or DraftOrderedMap hands out drafts ([285d5bc](https://github.com/andershessellund/valsem/commit/285d5bc5fa415234456e7c2e8d8baa3818412253))
* JSON.stringify sees the collections; lists and sets as arrays, maps as [key, value] pairs ([#28](https://github.com/andershessellund/valsem/issues/28)) ([0666e34](https://github.com/andershessellund/valsem/commit/0666e3409f44af0b415235ae5b4c2299b70f1abb))
* map, filter, reduce, some, every, find and findIndex on ValueList, the first five on the sets, and none of them drafts ([#57](https://github.com/andershessellund/valsem/issues/57)) ([a9d6119](https://github.com/andershessellund/valsem/commit/a9d61193aaf88b8fb8c4841a9ef4c249a1a2bd01))
* remove the deprecated createInterner ([8cd0103](https://github.com/andershessellund/valsem/commit/8cd0103323a7d60462c3fcbbc852d3bf0be8f922))
* the detached-draft function is draftOf, no longer draft ([111f9fc](https://github.com/andershessellund/valsem/commit/111f9fcfd39a8b8ee8f22e2c4088d8017aedb159))
* the sets' reduce folds from the first member when no initial value is given, HashMap and HashSet forEach take a thisArg, and HashMap, ValueMap.from and OrderedMap.from read entries as new Map does ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* ValueDate.of is ValueDate.from ([111f9fc](https://github.com/andershessellund/valsem/commit/111f9fcfd39a8b8ee8f22e2c4088d8017aedb159))
* ValueList.push and splice take their items as Array does ([0102223](https://github.com/andershessellund/valsem/commit/0102223ca1b9529f9a687e983e5ee749e93aea1c))
* ValueList.toSorted and toReversed, as Array.prototype has them ([#66](https://github.com/andershessellund/valsem/issues/66)) ([4c938b5](https://github.com/andershessellund/valsem/commit/4c938b5be984c119dd2752d70a1daa73820d7d8e))
* ValueSet.of, as ValueList.of and OrderedSet.of ([ee3a032](https://github.com/andershessellund/valsem/commit/ee3a032647c5d832b2a38b0f54cded9a63aca603))
* where a value is required, a draft stands for the value it holds right now ([be961a8](https://github.com/andershessellund/valsem/commit/be961a83669bcdf783ef881d49bce8d6364710a3))


### Bug Fixes

* a draft given to produce as its base stands for its current value ([#37](https://github.com/andershessellund/valsem/issues/37)) ([74834cf](https://github.com/andershessellund/valsem/commit/74834cfc775b9dd2cb01718805a99b5d44e56279))
* a draft walk is a native one — an entry deleted before the walk reaches it is not visited, a DraftSet visits members added during the walk, DraftList.forEach reads the length once ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* a pool calls a [hashCode] method instead of multiplying it, memoize refuses a class with the reason, DraftMap.clear is seen by a walk in progress, and the ordered drafts visit entries appended during a walk ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* a pool lookup whose predicate registers enough to finish a table copy still finds what it registered, and pool.intern accepts an instance its constructor froze ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* a record draft that holds a collection can be a set member or a map key ([be961a8](https://github.com/andershessellund/valsem/commit/be961a83669bcdf783ef881d49bce8d6364710a3))
* a record.set or record.delete patch whose path ends at a missing key, a missing index, null or a primitive is refused by name, not with the engine's TypeError ([643a803](https://github.com/andershessellund/valsem/commit/643a8032bcceb99ad41fac6d2a29024ca0dbb014))
* applyPatches no longer writes into the patch values it is given ([b2bdc53](https://github.com/andershessellund/valsem/commit/b2bdc53bd08e717f1225e735bace74b2279240a0))
* applyPatches says what is wrong with a malformed patch list ([#32](https://github.com/andershessellund/valsem/issues/32)) ([be59557](https://github.com/andershessellund/valsem/commit/be59557338aabc5cb0031c19cdc97681b9b3f581))
* array drafts no longer expose Object.prototype members as mutating methods ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* array hashes can no longer be collided without the seed ([#22](https://github.com/andershessellund/valsem/issues/22)) ([8828495](https://github.com/andershessellund/valsem/commit/88284953c770d938a68f918ccb49c3988d9c5145))
* assigning a draft into itself throws a teaching error instead of dropping the key ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* close the invariant gaps found in the external review ([#2](https://github.com/andershessellund/valsem/issues/2)) ([4528d1b](https://github.com/andershessellund/valsem/commit/4528d1bdcdc78cc9d07d4a3ceb4676013090f52f))
* cross-realm records, a truly development-only warning, normalised registry hashes ([#21](https://github.com/andershessellund/valsem/issues/21)) ([8f2bbc6](https://github.com/andershessellund/valsem/commit/8f2bbc669c6fe64844b173166de0db18895f50bf))
* deepEqual ignores non-enumerable own properties from both sides, and reads a [hashCode] as deepHash does ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* defineProperty on an array draft no longer loses the write and breaks the draft; it throws, as on a record draft ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* draft reads that go through the snapshot work in a bundle without current ([285d5bc](https://github.com/andershessellund/valsem/commit/285d5bc5fa415234456e7c2e8d8baa3818412253))
* DraftMap.size is a count kept as edits go; [equals] is identity on every wrapper; the per-kind zero-patch retraction goes ([#68](https://github.com/andershessellund/valsem/issues/68)) ([f50798e](https://github.com/andershessellund/valsem/commit/f50798e3515adfb0c699b15a9c6c5b104e64307f))
* editing a canonical element after pushing it into an array draft was silently lost ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* edits that net out emit no patches on a raw base, or on a draft given as the base ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* every NaN spelling hashes alike, so intern, the collections, HashMap and memoize find a NaN whatever its bits, and fastEqual(NaN, NaN) is true, as deepEqual says ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* fill checks a foreign draft at the call, as push does ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* intern no longer fails past 16.7 million live values, and the pool index no longer stalls as it grows ([#44](https://github.com/andershessellund/valsem/issues/44)) ([392f02a](https://github.com/andershessellund/valsem/commit/392f02ae2d9aade7fd199c93bc8417a5ee82db05))
* memoize keeps the function's own signature, overloads and type parameters included, and an unannotated callback is the implicit-any error that says to annotate ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* memoize names an anonymous class in its error instead of leaving the name blank ([643a803](https://github.com/andershessellund/valsem/commit/643a8032bcceb99ad41fac6d2a29024ca0dbb014))
* new HashMap(entries) and new HashSet(values) take what new Map and new Set take, where they silently ignored their argument ([ee3a032](https://github.com/andershessellund/valsem/commit/ee3a032647c5d832b2a38b0f54cded9a63aca603))
* new ValueDate(ms) and new InternedString(s, h) from JavaScript throw instead of minting unpooled instances that claim canonicality, and an own [interned] on an array is not the protocol ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* new ValueList(), ValueMap(), ValueSet(), OrderedMap(), OrderedSet() and RawArray() from JavaScript throw instead of minting instances that claim canonicality ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* Object.freeze, seal and preventExtensions on a draft throw a teaching error instead of an engine invariant error ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* OrderedMap&lt;K, V&gt; is assignable to OrderedMap&lt;K, unknown&gt; again ([#30](https://github.com/andershessellund/valsem/issues/30)) ([ba09d60](https://github.com/andershessellund/valsem/commit/ba09d600bb11f29e94ed8c0b73f3e88f47ecd473))
* patches now equal the result under aliasing, assign-back and edit-after-assign ([b2bdc53](https://github.com/andershessellund/valsem/commit/b2bdc53bd08e717f1225e735bace74b2279240a0))
* patches on 150,000-element arrays apply without a stack overflow, replaying pushes into a DraftList is no longer quadratic, and applyPatches reads a one-shot iterable once ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* pop, shift, splice and remove hand out what they removed drafted, and sort/reverse/fill/copyWithin return the draft, so the immer idioms work and produce never writes into a raw base ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* produce interns its input before drafting it, so it never modifies its input through any path; original() of a raw input is its canonical, and a non-value anywhere in a raw input is rejected before the recipe runs ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* produce(base, undefined) throws, a method read off an array draft throws after the recipe, delete past an array draft's end is a no-op, a non-enumerable own property of a raw base stays out of the result, memoize refuses a non-value argument before running the function, draft iterators throw once the recipe has ended, and position errors name the draft ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* published declarations no longer need the ES2025 collection lib ([#17](https://github.com/andershessellund/valsem/issues/17)) ([cdaa159](https://github.com/andershessellund/valsem/commit/cdaa1596610931581170714737fe08d3aa9a4d7a))
* reject or coerce non-integer indices, and order symbols in collision nodes ([#20](https://github.com/andershessellund/valsem/issues/20)) ([d19197b](https://github.com/andershessellund/valsem/commit/d19197ba1172053918aa55d2483299b8d6ccce8d))
* splice on a plain-array draft reads its arguments as Array does ([#26](https://github.com/andershessellund/valsem/issues/26)) ([1d69d18](https://github.com/andershessellund/valsem/commit/1d69d18858da46f4b7f22b063a951545cd97bb2c))
* the patches produceWithPatches returns are frozen ([496120b](https://github.com/andershessellund/valsem/commit/496120bab1a8a02c246d33c42eef088719dd4bc7))
* the published types no longer list internal members ([#64](https://github.com/andershessellund/valsem/issues/64)) ([2a2bee6](https://github.com/andershessellund/valsem/commit/2a2bee6b3aa038e91f4c72ae7fca19f1052673f6))
* ValueList.concat and diff check their argument whatever the receiver, and a draft given stands for its value ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))
* ValueMap and ValueSet [equals] answer false for an object that inherits their prototype without being one, instead of throwing ([643a803](https://github.com/andershessellund/valsem/commit/643a8032bcceb99ad41fac6d2a29024ca0dbb014))
* ValueSet.reduce and DraftSet.reduce require their initial value, as D54 says; OrderedSet's folds from the first member when none is given ([2e86725](https://github.com/andershessellund/valsem/commit/2e86725b4ef3e59cc0af663c37fabc6e5298fab0))


### Performance Improvements

* OrderedMap and OrderedSet deletes and inserts are about 30% faster ([#49](https://github.com/andershessellund/valsem/issues/49)) ([3f5f254](https://github.com/andershessellund/valsem/commit/3f5f2548633e045eec4737f9673e2c563762c1e8))
* the intern pool is an open table swept in place; FinalizationRegistry is no longer required ([#67](https://github.com/andershessellund/valsem/issues/67)) ([ce50141](https://github.com/andershessellund/valsem/commit/ce501419438d7bfb5a95a63f7501823c4220fcf7))
* trieDiff, the set operations' walk with a visitor; DraftSet is a working copy whose patches are the diff of base and work ([#70](https://github.com/andershessellund/valsem/issues/70)) ([2c75870](https://github.com/andershessellund/valsem/commit/2c7587059b5ad11ca2634e42c32d4b39daf26ec1))
* ValueMap and ValueSet updates are 14–35% faster, their wrapper hangs off the root node ([#48](https://github.com/andershessellund/valsem/issues/48)) ([d4721a1](https://github.com/andershessellund/valsem/commit/d4721a17d56b8f9b0ab5e705febe0081ef85f613))
