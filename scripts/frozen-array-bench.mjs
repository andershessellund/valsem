// ---------------------------------------------------------------------------
// frozen-array-bench — what V8 charges for a FROZEN array, per operation.
//
// valsem freezes the plain records and arrays it canonicalises. The freeze
// call itself is a map transition (~0.1 µs at any size); the cost is in the
// frozen STATE: V8 has fast paths for frozen elements in some builtins and
// not in others, and the JIT's keyed loads are among the losers. This is
// what `skipFreezing()` buys back, in your own loops over canonical state.
// Records are unaffected (a frozen fast-mode object reads at full speed);
// ValueList keeps its leaves unfrozen and never pays this.
//
// Run: node scripts/frozen-array-bench.mjs
// ---------------------------------------------------------------------------
function t(fn, it) {
  for (let i = 0; i < Math.max(50, it / 10); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < it; i++) fn();
  return Number(process.hrtime.bigint() - t0) / it / 1000;
}
const N = 10_000;
const kinds = {
  'ints (smi)': () => Array.from({ length: N }, (_, i) => i),
  doubles: () => Array.from({ length: N }, (_, i) => i + 0.5),
  objects: () => Array.from({ length: N }, (_, i) => ({ id: i, v: i })),
};
const val = (x) => (typeof x === 'object' ? x.v : x);
// One function per (op, frozenness) so each keyed-load site stays monomorphic.
const mk = (body) => [new Function('a', 'val', body), new Function('a', 'val', body)];
const ops = {
  'indexed loop read': mk('let s = 0; for (let i = 0; i < a.length; i++) s += val(a[i]); return s;'),
  'for-of': mk('let s = 0; for (const x of a) s += val(x); return s;'),
  forEach: mk('let s = 0; a.forEach((x) => { s += val(x); }); return s;'),
  map: mk('return a.map(val);'),
  filter: mk('return a.filter((x) => val(x) % 2 === 0);'),
  reduce: mk('return a.reduce((s, x) => s + val(x), 0);'),
  'indexOf (miss)': mk('return a.indexOf(-1);'),
  'includes (miss)': mk('return a.includes(-1);'),
  'slice()': mk('return a.slice();'),
  'spread [...a]': mk('return [...a];'),
  concat: mk('return a.concat([1]);'),
  'JSON.stringify': mk('return JSON.stringify(a);'),
  'at(-1) ×1000': mk('let s = 0; for (let i = 0; i < 1000; i++) s += val(a.at(-1 - (i & 7))); return s;'),
  'destructure [x, y] ×1000': mk('let s = 0; for (let i = 0; i < 1000; i++) { const [x, y] = a; s += val(x) + val(y); } return s;'),
};
for (const [kind, make] of Object.entries(kinds)) {
  console.log(`\n${kind}, ${N} elements — µs per op, unfrozen → frozen`);
  for (const [name, [opU, opF]] of Object.entries(ops)) {
    const u = make();
    const f = Object.freeze(make());
    const it = name.includes('×1000') || name.startsWith('JSON') ? 2000 : 5000;
    const tu = t(() => opU(u, val), it);
    const tf = t(() => opF(f, val), it);
    const ratio = tf / tu;
    console.log(`  ${name.padEnd(26)} ${tu.toFixed(2).padStart(8)} → ${tf.toFixed(2).padStart(8)}   ${ratio.toFixed(2)}×${ratio > 1.3 ? '  ◀' : ''}`);
  }
}
