// ---------------------------------------------------------------------------
// equal-bench — valsem deepEqual vs fast-deep-equal.
//
// Cases per shape/size:
//   raw =    equal raw pairs        (the pure walk — fast-deep-equal's arena)
//   raw ≠    unequal raw pairs      (difference planted mid-structure)
//   canon ≠  distinct CANONICAL pairs (valsem's O(1) fast path;
//            fast-deep-equal must walk — over frozen data, as its users
//            would meet valsem values in the wild)
//   boundary raw wrappers sharing a canonical subtree (valsem terminates at
//            the boundary; fast-deep-equal walks through it)
//
// Semantics note: fast-deep-equal answers false for NaN-vs-NaN and for
// { a: undefined } vs {}; valsem answers true for both. The corpus avoids
// those inputs, and every measured pair asserts verdict agreement.
//
// Run: pnpm build && node scripts/equal-bench.mjs
// ---------------------------------------------------------------------------
import { deepEqual } from '../dist/deep-equal.js';
import { intern } from '../dist/intern.js';
import fastDeepEqual from 'fast-deep-equal';

function t(name, fn, iter) {
  for (let i = 0; i < Math.min(2000, iter); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iter; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / iter;
  return ns;
}

function row(label, a, b, iter) {
  const expected = fastDeepEqual(a, b);
  if (deepEqual(a, b) !== expected) {
    throw new Error(`verdict mismatch on ${label}`);
  }
  const fde = t('fde', () => fastDeepEqual(a, b), iter);
  const val = t('valsem', () => deepEqual(a, b), iter);
  const ratio = fde / val;
  console.log(
    `  ${label.padEnd(34)} valsem ${fmt(val)}   fde ${fmt(fde)}   ${
      ratio >= 1 ? (ratio.toFixed(1) + '× faster') : ('1/' + (1 / ratio).toFixed(1) + '×')
    }`,
  );
}
const fmt = (ns) => (ns >= 1000 ? (ns / 1000).toFixed(1) + ' µs' : ns.toFixed(0) + ' ns').padStart(8);

function record(n, seed = 0) {
  const r = {};
  for (let i = 0; i < n; i++) r[`key${i}`] = i === (n >> 1) && seed ? seed : i;
  return r;
}
function numArray(n, seed = 0) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i === (n >> 1) && seed ? seed : i;
  return a;
}
function items(n, seed = 0) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = { id: i, label: `item-${i}`, value: i === (n >> 1) && seed ? seed : 0 };
  }
  return a;
}

for (const n of [10, 100, 1000]) {
  console.log(`\nflat record, ${n} keys`);
  const iter = Math.max(2000, 2_000_000 / n);
  row('raw = (walk)', record(n), record(n), iter);
  row('raw ≠ (mid difference)', record(n), record(n, -1), iter);
  row('canonical ≠', intern(record(n)), intern(record(n, -1)), iter);
}

for (const n of [10, 100, 1000]) {
  console.log(`\nflat number array, ${n} elements`);
  const iter = Math.max(2000, 4_000_000 / n);
  row('raw = (walk)', numArray(n), numArray(n), iter);
  row('raw ≠ (mid difference)', numArray(n), numArray(n, -1), iter);
  row('canonical ≠', intern(numArray(n)), intern(numArray(n, -1)), iter);
}

{
  console.log('\narray of 100 item records (nested)');
  const iter = 20_000;
  row('raw = (walk)', items(100), items(100), iter);
  row('raw ≠ (mid difference)', items(100), items(100, -1), iter);
  row('canonical ≠', intern(items(100)), intern(items(100, -1)), iter);
}

{
  console.log('\nboundary — raw wrappers over a shared canonical 100-item subtree');
  const payload = intern(items(100));
  const iter = 50_000;
  row('raw wrappers, shared payload =', { meta: 1, payload }, { meta: 1, payload }, iter);
  const other = intern(items(100, -1));
  row('raw wrappers, distinct payloads ≠', { meta: 1, payload }, { meta: 1, payload: other }, iter);
}
