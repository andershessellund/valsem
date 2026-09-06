// ---------------------------------------------------------------------------
// hashmap-bench — HashMap's two modes, by key kind.
//
// Default mode interns every key and keys a native Map by the canonical
// reference: a canonical key looks up at Map speed, a raw key pays an intern
// walk (copy, hash, pool lookup — and on a novel key, a pool entry). With
// { intern: false } keys are hashed and compared by content in a bucket
// table and stored as given: for keys that are new values every call.
//
// Run: pnpm build && node scripts/hashmap-bench.mjs
// ---------------------------------------------------------------------------
import { HashMap } from '../dist/hash-map.js';
import { intern } from '../dist/intern.js';

function t(fn, it = 300000) {
  for (let i = 0; i < 30000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / it;
}
const row = (name, a, b) =>
  console.log(`  ${name.padEnd(40)} ${a.toFixed(0).padStart(6)} ns   ${b.toFixed(0).padStart(6)} ns   ${(b / a).toFixed(2)}×`);
console.log('\n                                           intern:true  intern:false');
const keys = Array.from({ length: 4096 }, (_, i) => intern({ table: 'users', id: i }));
{
  const a = new HashMap(), b = new HashMap({ intern: false });
  for (const k of keys) { a.set(k, 1); b.set(k, 1); }
  row('get, canonical key (hit)', t((i) => a.get(keys[i & 4095])), t((i) => b.get(keys[i & 4095])));
  row('getCanonical, canonical key (hit)', t((i) => a.getCanonical(keys[i & 4095])), t((i) => b.getCanonical(keys[i & 4095])));
  row('get, raw 2-key object (hit)', t((i) => a.get({ table: 'users', id: i & 4095 })), t((i) => b.get({ table: 'users', id: i & 4095 })));
  row('get, primitive key (hit)', t((i) => a.get(i & 4095)), t((i) => b.get(i & 4095)));
}
{
  const a = new HashMap(), b = new HashMap({ intern: false });
  row('set, novel raw 2-key object', t((i) => a.set({ table: 'x', id: i }, 1), 100000), t((i) => b.set({ table: 'x', id: i }, 1), 100000));
}
{
  const big = Array.from({ length: 50 }, (_, i) => ({ id: i, v: i }));
  const a = new HashMap(), b = new HashMap({ intern: false });
  a.set({ items: big }, 1); b.set({ items: big }, 1);
  row('get, raw 50-item payload key (hit)', t(() => a.get({ items: big.map((x) => ({ ...x })) }), 20000), t(() => b.get({ items: big.map((x) => ({ ...x })) }), 20000));
}
