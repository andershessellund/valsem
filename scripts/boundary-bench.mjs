// ---------------------------------------------------------------------------
// boundary-bench — admitting raw data: the cost of intern() at the boundary.
//
// An API response arrives as raw JSON — 1,000 records of 10 fields is a
// generous upper bound for what a well-designed frontend processes in one
// tick. intern() walks it once, hashes every node, and canonicalises it;
// after that every comparison, memo hit and map lookup on it is O(1). This
// measures that admission cost, per response and per record, in three
// situations: the data is new; the same content arrives again (a refetch
// that changed nothing — every node hits the pool); and a refetch with 10%
// of the records changed. Baselines: JSON.parse of the same payload (a cost
// the app already pays), structuredClone, and immer's auto-freeze walk (the
// cheapest "make it immutable" a frontend runs today).
//
// Run: pnpm build && node scripts/boundary-bench.mjs [records] [fields]
// ---------------------------------------------------------------------------
import { intern } from '../dist/intern.js';
import { produce as immerProduce, setAutoFreeze } from 'immer';

const N = Number(process.argv[2] ?? 1000);
const F = Number(process.argv[3] ?? 10);

const record = (i, salt = 0) => {
  const r = { id: i + salt * 1e6, name: `user-${i}`, email: `user${i}@example.com`, active: i % 3 !== 0, score: i * 1.5 };
  for (let f = Object.keys(r).length; f < F; f++) r[`field${f}`] = f % 2 ? `v${i}-${f}` : i * f;
  return r;
};
const response = (salt = 0) => Array.from({ length: N }, (_, i) => record(i, salt));
const text = JSON.stringify(response());

function t(fn, it) {
  for (let i = 0; i < Math.max(5, it / 5); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / it / 1000;
}
const row = (name, us) =>
  console.log(`  ${name.padEnd(52)} ${us.toFixed(0).padStart(6)} µs   ${(us / N * 1000).toFixed(0).padStart(5)} ns/record   ${(us / 16000 * 100).toFixed(1).padStart(5)}% of a 16 ms frame`);

console.log(`\n${N} records × ${F} fields (${(text.length / 1024).toFixed(0)} KB of JSON)`);
row('JSON.parse (the app pays this anyway)', t(() => JSON.parse(text), 200));
row('structuredClone', t(() => structuredClone(JSON.parse(text)), 100) - t(() => JSON.parse(text), 200));
setAutoFreeze(true);
{
  const parsed = Array.from({ length: 40 }, () => JSON.parse(text)); let k = 0;
  row('immer produce(data, () => {}) — auto-freeze walk', t(() => immerProduce(parsed[k++ % 40], () => {}), 40));
}
{
  let salt = 1000;
  const fresh = Array.from({ length: 40 }, () => response(salt++)); let k = 0;
  row('intern, all new content', t(() => intern(fresh[k++ % 40]), 40));
}
{
  intern(response(0));
  const same = Array.from({ length: 40 }, () => JSON.parse(text)); let k = 0;
  row('intern, refetch of unchanged content (all pool hits)', t(() => intern(same[k++ % 40]), 40));
}
{
  intern(response(0));
  let salt = 5000;
  const partly = Array.from({ length: 40 }, () => { const r = response(0); for (let i = 0; i < N; i += 10) r[i] = record(i, salt); salt++; return r; }); let k = 0;
  row('intern, refetch with 10% of records changed', t(() => intern(partly[k++ % 40]), 40));
}
