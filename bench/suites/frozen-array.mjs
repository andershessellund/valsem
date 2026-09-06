import { time, row } from '../lib.mjs';

const N = 10_000;

export default {
  id: 'frozen-array',
  title: 'Frozen arrays — what the engine charges for the frozen state',
  description: `
valsem freezes the plain arrays it canonicalises. The \`Object.freeze\` call is a map transition (~0.1 µs at any size);
the cost is the frozen **state**: engines have fast paths for frozen elements in some builtins and not in others.
The first row is the freeze call itself — a map transition on V8, an O(n) walk on JavaScriptCore, where it is the
dominant cost of canonicalising a large array. Each following row is one operation over a 10,000-element array,
unfrozen and then frozen, with one function per call site so the keyed loads stay monomorphic. Three element kinds: integers (Smi), doubles, and objects. This is the cost
\`skipFreezing()\` buys back in the user's own loops; \`ValueList\` never pays it (its leaves are unfrozen inside a frozen
wrapper).
`,
  columns: ['ints unfrozen', 'ints frozen', 'doubles unfrozen', 'doubles frozen', 'objects unfrozen', 'objects frozen'],
  unit: 'ns',
  rows() {
    const rows = [];
    // The freeze call itself, per kind: a map transition on V8, an O(n) walk on JavaScriptCore.
    {
      const values = {};
      for (const [kind, make] of Object.entries({
        ints: () => Array.from({ length: N }, (_, i) => i),
        doubles: () => Array.from({ length: N }, (_, i) => i + 0.5),
        objects: () => Array.from({ length: N }, (_, i) => ({ id: i, v: i })),
      })) {
        const fresh = Array.from({ length: 300 }, make);
        let k = 0;
        values[`${kind} unfrozen`] = null;
        values[`${kind} frozen`] = time(() => Object.freeze(fresh[k++ % 300]), 250);
      }
      rows.push(row('the Object.freeze call itself (10k elements)', values));
    }
    const kinds = {
      ints: () => Array.from({ length: N }, (_, i) => i),
      doubles: () => Array.from({ length: N }, (_, i) => i + 0.5),
      objects: () => Array.from({ length: N }, (_, i) => ({ id: i, v: i })),
    };
    const val = (x) => (typeof x === 'object' ? x.v : x);
    const mk = (body) => [new Function('a', 'val', body), new Function('a', 'val', body)];
    const ops = {
      'indexed loop read': mk('let s = 0; for (let i = 0; i < a.length; i++) s += val(a[i]); return s;'),
      'for…of': mk('let s = 0; for (const x of a) s += val(x); return s;'),
      forEach: mk('let s = 0; a.forEach((x) => { s += val(x); }); return s;'),
      map: mk('return a.map(val);'),
      filter: mk('return a.filter((x) => val(x) % 2 === 0);'),
      reduce: mk('return a.reduce((s, x) => s + val(x), 0);'),
      'indexOf (miss)': mk('return a.indexOf(-1);'),
      'slice()': mk('return a.slice();'),
      'spread [...a]': mk('return [...a];'),
      concat: mk('return a.concat([1]);'),
      'JSON.stringify': mk('return JSON.stringify(a);'),
      'at(-1) ×1000': mk('let s = 0; for (let i = 0; i < 1000; i++) s += val(a.at(-1 - (i & 7))); return s;'),
    };
    for (const [name, [opU, opF]] of Object.entries(ops)) {
      const values = {};
      for (const [kind, make] of Object.entries(kinds)) {
        const u = make(), f = Object.freeze(make());
        const it = name.includes('×1000') || name.startsWith('JSON') ? 1000 : 3000;
        values[`${kind} unfrozen`] = time(() => opU(u, val), it);
        values[`${kind} frozen`] = time(() => opF(f, val), it);
      }
      rows.push(row(name, values));
    }
    return rows;
  },
};
