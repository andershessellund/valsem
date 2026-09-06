import { time, row } from '../lib.mjs';
import { deepEqual } from '../../dist/deep-equal.js';
import { intern } from '../../dist/intern.js';
import fastDeepEqual from 'fast-deep-equal';

function record(n, seed = 0) {
  const entries = [];
  for (let i = 0; i < n; i++) entries.push([`key${i}`, i === n >> 1 && seed ? seed : i]);
  return Object.fromEntries(entries);
}
function numArray(n, seed = 0) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i === n >> 1 && seed ? seed : i;
  return a;
}
function items(n, seed = 0) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = { id: i, label: `item-${i}`, value: i === n >> 1 && seed ? seed : 0 };
  return a;
}

export default {
  id: 'equality',
  title: 'deepEqual — against fast-deep-equal',
  description: `
Structural equality on raw data (the pure walk, fast-deep-equal's arena) and on canonical data (valsem's O(1)
short-circuit, which fast-deep-equal must still walk — over frozen objects, as its users would meet valsem values).
Every pair asserts that both libraries return the same verdict; the corpus avoids the two inputs on which their
semantics differ (\`NaN\` and undefined-valued keys). Rows:

- **raw =**: two independently built equal structures — the full walk.
- **raw ≠**: a difference planted in the middle.
- **canonical ≠**: two distinct canonical values — valsem answers from the canonicality probe without looking inside.
- **boundary**: raw wrappers around a shared canonical 100-item subtree — valsem terminates at the boundary.
`,
  columns: ['valsem', 'fast-deep-equal'],
  unit: 'ns',
  ratio: ['valsem', 'fast-deep-equal'],
  rows() {
    const rows = [];
    const cmp = (name, a, b, it) => {
      const expected = fastDeepEqual(a, b);
      if (deepEqual(a, b) !== expected) throw new Error(`verdict mismatch on ${name}`);
      rows.push(row(name, { valsem: time(() => deepEqual(a, b), it), 'fast-deep-equal': time(() => fastDeepEqual(a, b), it) }));
    };
    for (const n of [10, 100, 1000]) {
      const it = Math.max(2000, 2_000_000 / n);
      cmp(`record ${n} keys: raw =`, record(n), record(n), it);
      cmp(`record ${n} keys: raw ≠`, record(n), record(n, -1), it);
      cmp(`record ${n} keys: canonical ≠`, intern(record(n)), intern(record(n, -1)), it);
    }
    for (const n of [10, 100, 1000]) {
      const it = Math.max(2000, 4_000_000 / n);
      cmp(`number array ${n}: raw =`, numArray(n), numArray(n), it);
      cmp(`number array ${n}: raw ≠`, numArray(n), numArray(n, -1), it);
      cmp(`number array ${n}: canonical ≠`, intern(numArray(n)), intern(numArray(n, -1)), it);
    }
    {
      const it = 40_000;
      cmp('array of 100 records: raw =', items(100), items(100), it);
      cmp('array of 100 records: raw ≠', items(100), items(100, -1), it);
      cmp('array of 100 records: canonical ≠', intern(items(100)), intern(items(100, -1)), it);
    }
    {
      const shared = intern(items(100));
      const other = intern(items(100, -1));
      cmp('boundary: raw wrappers, shared canonical payload =', { meta: 1, payload: shared }, { meta: 1, payload: shared }, 400_000);
      cmp('boundary: raw wrappers, distinct canonical payloads ≠', { meta: 1, payload: shared }, { meta: 1, payload: other }, 400_000);
    }
    return rows;
  },
};
