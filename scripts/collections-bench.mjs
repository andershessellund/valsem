// ---------------------------------------------------------------------------
// collections-bench — ValueMap / ValueSet / ValueList vs Immutable.js.
//
// Immutable.js is the closest structural comparison: its Map/Set are HAMTs
// and its List is a 32-way radix vector, like valsem's. The difference is
// what the two libraries make of the structure: Immutable answers `equals`
// and `hashCode` by walking (caching the hash per instance); valsem hash-
// conses every node, so equal content IS the same instance, equality is
// `===`, and the hash is a field.
//
// Sections per structure, at N = 100 and N = 10,000 (primitive keys/values,
// so intern-on-entry is a no-op and the trie/vector work is what is timed):
//
//   build          from N entries / members / elements
//   get / has      hit and miss
//   set / add      existing key with a NOVEL value; a new key (persistent)
//   delete
//   iterate        full traversal
//   set+hash       one persistent update, then read the hash — valsem pays
//                  hashing inside the update (consing), Immutable lazily on
//                  the first hashCode() of the successor
//   equals =       two INDEPENDENTLY built equal collections (shuffled
//                  insertion order) — valsem `deepEqual` is the [interned]
//                  fast path; Immutable `is()` walks
//   equals ≠       equal but for one entry — cold, and again with Immutable's
//                  per-instance hash cache warmed: is() short-circuits on
//                  cached hashes that differ, so once hashed, an UNEQUAL
//                  Immutable compare is O(1) too (an equal one must still walk)
//
// Then one section with RECORD values, to show the intern-on-entry tax: the
// semantics differ there (valsem dedups structurally and freezes; Immutable
// stores references), so it is reported, not compared.
//
// Every row asserts that both libraries produced the same answer.
//
// Run: pnpm build && node scripts/collections-bench.mjs [iterations-scale]
// ---------------------------------------------------------------------------
import { Map as IMap, Set as ISet, List as IList, is as iIs, hash as iHash } from 'immutable';

// VALSEM_DIST=../dist-fr selects an alternative build (e.g. the
// FinalizationRegistry pool experiment); default is the shipped build.
const DIST = process.env.VALSEM_DIST ?? '../dist';
const { ValueMap } = await import(`${DIST}/value-map.js`);
const { ValueSet } = await import(`${DIST}/value-set.js`);
const { ValueList } = await import(`${DIST}/value-list.js`);
const { deepEqual } = await import(`${DIST}/deep-equal.js`);
const { deepHash } = await import(`${DIST}/deep-hash.js`);
console.log(`build: ${DIST}   runtime: ${typeof Bun !== 'undefined' ? 'bun ' + Bun.version + ' (JavaScriptCore)' : 'node ' + process.version + ' (V8)'}`);

const SCALE = Number(process.argv[2] ?? 1);

function t(fn, iter) {
  for (let i = 0; i < Math.min(2000, iter); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iter; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / iter;
}

const fmt = (ns) =>
  (ns >= 1e6 ? (ns / 1e6).toFixed(2) + ' ms' : ns >= 1000 ? (ns / 1000).toFixed(1) + ' µs' : ns.toFixed(0) + ' ns').padStart(9);

/** One comparison row: `val` and `imm` are (i) => result; `check` asserts agreement once. */
function row(label, val, imm, iter, check) {
  iter = Math.max(50, Math.round(iter * SCALE));
  if (check) check(val(0), imm(0));
  const v = t(val, iter);
  const m = t(imm, iter);
  const r = m / v;
  console.log(
    `  ${label.padEnd(30)} valsem ${fmt(v)}   immutable ${fmt(m)}   ${
      r >= 1 ? (r.toFixed(1) + '× faster').padStart(14) : ('1/' + (1 / r).toFixed(1) + '×').padStart(14)
    }`,
  );
}

function assertEq(a, b, what) {
  if (a !== b) throw new Error(`result mismatch (${what}): ${String(a)} vs ${String(b)}`);
}

// Deterministic shuffle so "independently built" means a different insertion order.
function shuffled(arr, seed = 1) {
  const out = arr.slice();
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SIZES = [100, 10_000];

// ===========================================================================
// Map
// ===========================================================================
for (const N of SIZES) {
  console.log(`\nMap — ${N} entries, string keys, number values`);
  const entries = Array.from({ length: N }, (_, i) => [`k${i}`, i]);
  const keys = entries.map(([k]) => k);
  const vm = ValueMap.from(entries);
  const im = IMap(entries);
  const vm2 = ValueMap.from(shuffled(entries));
  const im2 = IMap(shuffled(entries));
  const oneOff = entries.map(([k, v], i) => (i === N >> 1 ? [k, -1] : [k, v]));
  const vmDiff = ValueMap.from(oneOff);
  const imDiff = IMap(oneOff);
  const perOp = 2_000_000 / Math.log2(N + 2);
  const perWalk = Math.max(20, 400_000 / N);

  row('build from entries', () => ValueMap.from(entries).size, () => IMap(entries).size, perWalk, assertEq);
  row('get (hit)', (i) => vm.get(keys[i % N]), (i) => im.get(keys[i % N]), perOp, assertEq);
  row('has (miss)', (i) => vm.has('nope' + (i % N)), (i) => im.has('nope' + (i % N)), perOp, assertEq);
  row('set existing → novel value', (i) => vm.set(keys[i % N], -i).size, (i) => im.set(keys[i % N], -i).size, perOp, assertEq);
  row('set new key', (i) => vm.set('new' + i, i).size, (i) => im.set('new' + i, i).size, perOp, assertEq);
  row('delete existing', (i) => vm.delete(keys[i % N]).size, (i) => im.delete(keys[i % N]).size, perOp, assertEq);
  row(
    'iterate entries',
    () => { let s = 0; for (const [, v] of vm) s += v; return s; },
    () => { let s = 0; for (const [, v] of im) s += v; return s; },
    perWalk,
    assertEq,
  );
  row(
    'set one key, then hash',
    (i) => deepHash(vm.set(keys[i % N], -i)),
    (i) => iHash(im.set(keys[i % N], -i)),
    Math.max(50, 200_000 / N),
    (a, b) => { assertEq(typeof a, typeof b, 'hash type'); },
  );
  row('equals = (independent builds)', () => deepEqual(vm, vm2), () => iIs(im, im2), perWalk * 4, (a, b) => { assertEq(a, true); assertEq(b, true); });
  row('equals ≠ (one entry differs)', () => deepEqual(vm, vmDiff), () => iIs(im, imDiff), perWalk * 4, (a, b) => { assertEq(a, false); assertEq(b, false); });
  iHash(im); iHash(imDiff); // warm Immutable's cached hashes
  row('equals ≠ (hashes warmed)', () => deepEqual(vm, vmDiff), () => iIs(im, imDiff), perOp, (a, b) => { assertEq(a, false); assertEq(b, false); });
}

// ===========================================================================
// Set
// ===========================================================================
for (const N of SIZES) {
  console.log(`\nSet — ${N} string members`);
  const members = Array.from({ length: N }, (_, i) => `m${i}`);
  const vs = ValueSet.from(members);
  const is = ISet(members);
  const vs2 = ValueSet.from(shuffled(members, 7));
  const is2 = ISet(shuffled(members, 7));
  const oneOff = members.map((m, i) => (i === N >> 1 ? 'other' : m));
  const vsDiff = ValueSet.from(oneOff);
  const isDiff = ISet(oneOff);
  const perOp = 2_000_000 / Math.log2(N + 2);
  const perWalk = Math.max(20, 400_000 / N);

  row('build from members', () => ValueSet.from(members).size, () => ISet(members).size, perWalk, assertEq);
  row('has (hit)', (i) => vs.has(members[i % N]), (i) => is.has(members[i % N]), perOp, assertEq);
  row('has (miss)', (i) => vs.has('nope' + (i % N)), (i) => is.has('nope' + (i % N)), perOp, assertEq);
  row('add new member', (i) => vs.add('new' + i).size, (i) => is.add('new' + i).size, perOp, assertEq);
  row('add existing (no-op)', (i) => vs.add(members[i % N]) === vs, (i) => is.add(members[i % N]) === is, perOp, assertEq);
  row('delete existing', (i) => vs.delete(members[i % N]).size, (i) => is.delete(members[i % N]).size, perOp, assertEq);
  row(
    'iterate members',
    () => { let n = 0; for (const m of vs) n += m.length; return n; },
    () => { let n = 0; for (const m of is) n += m.length; return n; },
    perWalk,
    assertEq,
  );
  row(
    'add one member, then hash',
    (i) => deepHash(vs.add('new' + i)),
    (i) => iHash(is.add('new' + i)),
    Math.max(50, 200_000 / N),
    (a, b) => { assertEq(typeof a, typeof b, 'hash type'); },
  );
  row('equals = (independent builds)', () => deepEqual(vs, vs2), () => iIs(is, is2), perWalk * 4, (a, b) => { assertEq(a, true); assertEq(b, true); });
  row('equals ≠ (one member differs)', () => deepEqual(vs, vsDiff), () => iIs(is, isDiff), perWalk * 4, (a, b) => { assertEq(a, false); assertEq(b, false); });
  iHash(is); iHash(isDiff);
  row('equals ≠ (hashes warmed)', () => deepEqual(vs, vsDiff), () => iIs(is, isDiff), perOp, (a, b) => { assertEq(a, false); assertEq(b, false); });
}

// ===========================================================================
// List
// ===========================================================================
for (const N of SIZES) {
  console.log(`\nList — ${N} number elements`);
  const arr = Array.from({ length: N }, (_, i) => i);
  const vl = ValueList.from(arr);
  const il = IList(arr);
  // "Independent build": push-chain for valsem (a different route to the same
  // canonical), IList().push chain for Immutable.
  let vl2 = ValueList.empty();
  let il2 = IList();
  for (const x of arr) { vl2 = vl2.push(x); il2 = il2.push(x); }
  const oneOff = arr.map((x, i) => (i === N >> 1 ? -1 : x));
  const vlDiff = ValueList.from(oneOff);
  const ilDiff = IList(oneOff);
  const perOp = 2_000_000 / Math.log2(N + 2);
  const perWalk = Math.max(20, 400_000 / N);
  const mid = N >> 1;

  row('build from array', () => ValueList.from(arr).length, () => IList(arr).size, perWalk, assertEq);
  row('get (mid index)', (i) => vl.get((mid + i) % N), (i) => il.get((mid + i) % N), perOp, assertEq);
  row('set (mid) → novel value', (i) => vl.set(mid, -i).get(mid), (i) => il.set(mid, -i).get(mid), perOp, assertEq);
  row('push', (i) => vl.push(i).length, (i) => il.push(i).size, perOp, assertEq);
  row('pop', () => vl.pop().length, () => il.pop().size, perOp, assertEq);
  row(
    'iterate elements',
    () => { let s = 0; for (const x of vl) s += x; return s; },
    () => { let s = 0; for (const x of il) s += x; return s; },
    perWalk,
    assertEq,
  );
  row(
    'push one, then hash',
    (i) => deepHash(vl.push(i)),
    (i) => iHash(il.push(i)),
    Math.max(50, 200_000 / N),
    (a, b) => { assertEq(typeof a, typeof b, 'hash type'); },
  );
  row('equals = (from vs push-chain)', () => deepEqual(vl, vl2), () => iIs(il, il2), perWalk * 4, (a, b) => { assertEq(a, true); assertEq(b, true); });
  row('equals ≠ (one element differs)', () => deepEqual(vl, vlDiff), () => iIs(il, ilDiff), perWalk * 4, (a, b) => { assertEq(a, false); assertEq(b, false); });
  iHash(il); iHash(ilDiff);
  row('equals ≠ (hashes warmed)', () => deepEqual(vl, vlDiff), () => iIs(il, ilDiff), perOp, (a, b) => { assertEq(a, false); assertEq(b, false); });
}

// ===========================================================================
// Record values — the intern-on-entry tax (reported, not compared: the
// semantics differ. valsem canonicalises and freezes each record, so equal
// records are one instance and ARE part of the value; Immutable stores the
// reference, so two maps built from equal-but-distinct records are unequal.)
// ===========================================================================
{
  const N = 10_000;
  console.log(`\nMap with RECORD values — ${N} entries of { id, label, tags: [..] } (intern-on-entry tax)`);
  const entries = Array.from({ length: N }, (_, i) => [`k${i}`, { id: i, label: `item-${i}`, tags: ['a', 'b'] }]);
  const fresh = () => entries.map(([k, v]) => [k, { ...v, tags: v.tags.slice() }]); // distinct objects, equal content
  const vm = ValueMap.from(entries);
  const im = IMap(entries);
  const perWalk = Math.max(20, 200_000 / N);
  row('build from RAW records', () => ValueMap.from(fresh()).size, () => IMap(fresh()).size, perWalk, assertEq);
  row('build from CANONICAL records', () => ValueMap.from(entries).size, () => IMap(entries).size, perWalk, assertEq);
  row('set one RAW record', (i) => vm.set('k1', { id: 1, label: 'item-1', tags: ['a', 'b'], v: i }).size, (i) => im.set('k1', { id: 1, label: 'item-1', tags: ['a', 'b'], v: i }).size, 50_000, assertEq);
  const vmB = ValueMap.from(fresh());
  const imB = IMap(fresh());
  console.log(
    `  equal-content records, independently built: valsem deepEqual=${deepEqual(vm, vmB)} (same instance: ${vm === vmB}); immutable is()=${iIs(im, imB)} — different semantics by design`,
  );
}
