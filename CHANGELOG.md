# Changelog

## [1.0.0](https://github.com/andershessellund/valsem/compare/v0.0.4...v1.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* the two patch lists returned by produceWithPatches, each patch object, and its path and insert arrays are now frozen (unless skipFreezing() was called), and typed readonly. Code that pushed onto a returned list or edited a patch in place must copy first: history.push(...patches) still works, patches.push(x) throws.
* createInterner() is gone. It returned { intern } over the global pool, so replace createInterner().intern(x) with intern(x).
* on ValueList, OrderedMap, OrderedSet, RawArray and their drafts, get, at, keyAt, valueAt and remove now throw a RangeError for an index outside [0, length) where they returned undefined (or, for remove, did nothing or counted a negative index from the end), and their return types no longer include undefined; compare with length to probe. insert and the start of splice take an integer in [0, length] and no longer clamp or count from the end. slice, and the count of splice, still clamp as Array does. Every positional argument must be an integer: NaN, 1.5 and '2' throw where they were coerced, including in splice, fill and copyWithin on a plain array inside a recipe, where splice(i, undefined, x) throws as well. applyPatches refuses a list.set or list.splice whose index or count does not fit the value, and a sequence op aimed at a record.

### Features

* a draft has every method of its value ([#33](https://github.com/andershessellund/valsem/issues/33)) ([3490823](https://github.com/andershessellund/valsem/commit/3490823ad01b13fff33b4dda85f75a71b798d477))
* a position is checked: NaN, fractions, and an index that names no element throw ([b2b7c56](https://github.com/andershessellund/valsem/commit/b2b7c5661fe731eee521b9224e67a7c9b8407b57))
* castDraft, for assigning a value into a draft slot ([#35](https://github.com/andershessellund/valsem/issues/35)) ([5bd7fd5](https://github.com/andershessellund/valsem/commit/5bd7fd58237d79d6bd869a563b861841956ec62f))
* console.log sees the collections; util.inspect and Symbol.toStringTag on every collection and draft ([#34](https://github.com/andershessellund/valsem/issues/34)) ([7698414](https://github.com/andershessellund/valsem/commit/7698414b55408ec3f4845118fdb7eb5fceab5780))
* JSON.stringify sees the collections; lists and sets as arrays, maps as [key, value] pairs ([#28](https://github.com/andershessellund/valsem/issues/28)) ([0666e34](https://github.com/andershessellund/valsem/commit/0666e3409f44af0b415235ae5b4c2299b70f1abb))
* remove the deprecated createInterner ([8cd0103](https://github.com/andershessellund/valsem/commit/8cd0103323a7d60462c3fcbbc852d3bf0be8f922))


### Bug Fixes

* a draft given to produce as its base stands for its current value ([#37](https://github.com/andershessellund/valsem/issues/37)) ([74834cf](https://github.com/andershessellund/valsem/commit/74834cfc775b9dd2cb01718805a99b5d44e56279))
* applyPatches no longer writes into the patch values it is given ([b2bdc53](https://github.com/andershessellund/valsem/commit/b2bdc53bd08e717f1225e735bace74b2279240a0))
* applyPatches says what is wrong with a malformed patch list ([#32](https://github.com/andershessellund/valsem/issues/32)) ([be59557](https://github.com/andershessellund/valsem/commit/be59557338aabc5cb0031c19cdc97681b9b3f581))
* array drafts no longer expose Object.prototype members as mutating methods ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* array hashes can no longer be collided without the seed ([#22](https://github.com/andershessellund/valsem/issues/22)) ([8828495](https://github.com/andershessellund/valsem/commit/88284953c770d938a68f918ccb49c3988d9c5145))
* assigning a draft into itself throws a teaching error instead of dropping the key ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* close the invariant gaps found in the external review ([#2](https://github.com/andershessellund/valsem/issues/2)) ([4528d1b](https://github.com/andershessellund/valsem/commit/4528d1bdcdc78cc9d07d4a3ceb4676013090f52f))
* cross-realm records, a truly development-only warning, normalised registry hashes ([#21](https://github.com/andershessellund/valsem/issues/21)) ([8f2bbc6](https://github.com/andershessellund/valsem/commit/8f2bbc669c6fe64844b173166de0db18895f50bf))
* defineProperty on an array draft no longer loses the write and breaks the draft; it throws, as on a record draft ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* editing a canonical element after pushing it into an array draft was silently lost ([0a21b45](https://github.com/andershessellund/valsem/commit/0a21b45ca8ab25b60ea4f780d2edaf16c855be8a))
* fill checks a foreign draft at the call, as push does ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* intern no longer fails past 16.7 million live values, and the pool index no longer stalls as it grows ([#44](https://github.com/andershessellund/valsem/issues/44)) ([392f02a](https://github.com/andershessellund/valsem/commit/392f02ae2d9aade7fd199c93bc8417a5ee82db05))
* Object.freeze, seal and preventExtensions on a draft throw a teaching error instead of an engine invariant error ([63ada45](https://github.com/andershessellund/valsem/commit/63ada450bc7a1de523f998a56614a6a499d4150f))
* OrderedMap&lt;K, V&gt; is assignable to OrderedMap&lt;K, unknown&gt; again ([#30](https://github.com/andershessellund/valsem/issues/30)) ([ba09d60](https://github.com/andershessellund/valsem/commit/ba09d600bb11f29e94ed8c0b73f3e88f47ecd473))
* patches now equal the result under aliasing, assign-back and edit-after-assign ([b2bdc53](https://github.com/andershessellund/valsem/commit/b2bdc53bd08e717f1225e735bace74b2279240a0))
* published declarations no longer need the ES2025 collection lib ([#17](https://github.com/andershessellund/valsem/issues/17)) ([cdaa159](https://github.com/andershessellund/valsem/commit/cdaa1596610931581170714737fe08d3aa9a4d7a))
* reject or coerce non-integer indices, and order symbols in collision nodes ([#20](https://github.com/andershessellund/valsem/issues/20)) ([d19197b](https://github.com/andershessellund/valsem/commit/d19197ba1172053918aa55d2483299b8d6ccce8d))
* splice on a plain-array draft reads its arguments as Array does ([#26](https://github.com/andershessellund/valsem/issues/26)) ([1d69d18](https://github.com/andershessellund/valsem/commit/1d69d18858da46f4b7f22b063a951545cd97bb2c))
* the patches produceWithPatches returns are frozen ([496120b](https://github.com/andershessellund/valsem/commit/496120bab1a8a02c246d33c42eef088719dd4bc7))


### Performance Improvements

* OrderedMap and OrderedSet deletes and inserts are about 30% faster ([#49](https://github.com/andershessellund/valsem/issues/49)) ([3f5f254](https://github.com/andershessellund/valsem/commit/3f5f2548633e045eec4737f9673e2c563762c1e8))
* ValueMap and ValueSet updates are 14–35% faster, their wrapper hangs off the root node ([#48](https://github.com/andershessellund/valsem/issues/48)) ([d4721a1](https://github.com/andershessellund/valsem/commit/d4721a17d56b8f9b0ab5e705febe0081ef85f613))
