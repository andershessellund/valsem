// ---------------------------------------------------------------------------
// record-copy-bench — two V8 facts that decide how fast a wide record copies.
//
// 1. An object grown by assigning keys one at a time into `{}` flips into
//    dictionary mode at ~20 keys; Object.fromEntries stays in fast mode at any
//    width. intern() builds canonical records with fromEntries for this reason.
// 2. Object spread goes through CloneObjectIC. A library's single copy site
//    sees every shape in the application, so it is megamorphic in practice,
//    and the generic fallback costs ~100 ns per property. Object.assign's
//    builtin fast path keys on the source map and stays at memcpy speed.
//    produce's draft copy uses Object.assign for this reason.
//
// Run: node --allow-natives-syntax scripts/record-copy-bench.mjs
// ---------------------------------------------------------------------------

const natives = (() => {
  try {
    return new Function('o', 'return %HasFastProperties(o)');
  } catch {
    return undefined;
  }
})();
const fast = (o) => (natives ? String(natives(o)) : 'n/a (run with --allow-natives-syntax)');

function t(fn, it) {
  for (let i = 0; i < 2000; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn();
  return Number(process.hrtime.bigint() - t0) / it / 1000;
}
const us = (x) => `${x.toFixed(2).padStart(7)} µs`;

console.log('\n1. property mode by construction (fresh process)');
for (const n of [12, 20, 128, 1000]) {
  const keys = Array.from({ length: n }, (_, i) => `k${i}`).sort();
  const grown = {};
  for (const k of keys) grown[k] = 1;
  const built = Object.fromEntries(keys.map((k) => [k, 1]));
  console.log(`  n=${String(n).padStart(4)}  key-by-key fast=${fast(grown)}   fromEntries fast=${fast(built)}`);
}

console.log('\n2. copy cost at a megamorphic site (12 shapes seen first), fast-mode frozen sources');
const shapes = Array.from({ length: 12 }, (_, s) =>
  Object.freeze(Object.fromEntries(Array.from({ length: 5 + s }, (_, i) => [`s${s}_${i}`, i]))),
);
function spreadSite(o) {
  return { ...o };
}
function assignSite(o) {
  return Object.assign({}, o);
}
function monoSpread(o) {
  return { ...o };
}
for (const s of shapes) {
  for (let i = 0; i < 100; i++) {
    spreadSite(s);
    assignSite(s);
  }
}
const dict = {};
for (let i = 0; i < 1000; i++) dict[`d${i}`] = i;
Object.freeze(dict);
for (const n of [3, 20, 100, 1000]) {
  const base = Object.freeze(Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, i])));
  const it = n >= 1000 ? 3000 : 20000;
  const mono = t(() => monoSpread(base), it); // this site only ever sees these four maps
  console.log(
    `  n=${String(n).padStart(4)}  spread, ≤4 shapes ${us(mono)}   spread, megamorphic ${us(t(() => spreadSite(base), it))}   Object.assign, megamorphic ${us(t(() => assignSite(base), it))}`,
  );
}
console.log(`  dictionary-mode 1000-key source: spread ${us(t(() => spreadSite(dict), 2000))}   Object.assign ${us(t(() => assignSite(dict), 2000))}`);
