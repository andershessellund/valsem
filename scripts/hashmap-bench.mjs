// ---------------------------------------------------------------------------
// hashmap-bench — the two mutable maps, by key kind.
//
// HashMap matches keys by content (hash + structural compare, keys stored as
// given, never interned). FastMap is a native Map that only admits canonical
// keys — reference equality is value equality there — checked while checks
// are on, and literally `Map` after skipChecks().
//
// Run: pnpm build && node scripts/hashmap-bench.mjs
// ---------------------------------------------------------------------------
import { HashMap } from '../dist/hash-map.js';
import { FastMap } from '../dist/fast-collections.js';
import { intern } from '../dist/intern.js';
import { skipChecks } from '../dist/checks.js';

function t(fn, it = 300000) {
  for (let i = 0; i < 30000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / it;
}
const ns = (x) => `${x.toFixed(0).padStart(6)} ns`;
const keys = Array.from({ length: 4096 }, (_, i) => intern({ table: 'users', id: i }));
const fill = (m) => { for (let i = 0; i < keys.length; i++) m.set(keys[i], i); return m; };

console.log('\ncanonical keys, hit                          HashMap   FastMap(checks on)   native Map');
{
  const h = fill(new HashMap()), f = fill(new FastMap()), n = fill(new Map());
  const row = (name, a, b, c) => console.log(`  ${name.padEnd(40)} ${ns(a)}   ${ns(b)}           ${ns(c)}`);
  row('get, canonical object key', t((i) => h.get(keys[i & 4095])), t((i) => f.get(keys[i & 4095])), t((i) => n.get(keys[i & 4095])));
  row('get, primitive key', t((i) => h.get(i & 4095)), t((i) => f.get(i & 4095)), t((i) => n.get(i & 4095)));
}
console.log('\nraw keys (HashMap only — FastMap rejects them)');
{
  const h = fill(new HashMap());
  console.log(`  ${'get, raw 2-key object (hit)'.padEnd(40)} ${ns(t((i) => h.get({ table: 'users', id: i & 4095 })))}`);
  const big = Array.from({ length: 50 }, (_, i) => ({ id: i, v: i }));
  h.set({ items: big }, 1);
  console.log(`  ${'get, raw 50-item payload key (hit)'.padEnd(40)} ${ns(t(() => h.get({ items: big.map((x) => ({ ...x })) }), 20000))}`);
  const s = new HashMap();
  console.log(`  ${'set, novel raw 2-key object'.padEnd(40)} ${ns(t((i) => s.set({ table: 'x', id: i }, 1), 100000))}`);
}
skipChecks();
console.log('\nafter skipChecks()');
{
  const f = fill(new FastMap());
  console.log(`  new FastMap() is a native Map: ${f.constructor === Map}`);
  console.log(`  ${'get, canonical object key'.padEnd(40)} ${ns(t((i) => f.get(keys[i & 4095])))}`);
}
