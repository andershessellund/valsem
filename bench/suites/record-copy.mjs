import { time, row } from '../lib.mjs';

export default {
  id: 'record-copy',
  title: 'Copying a wide record — dictionary mode and megamorphic spread',
  description: `
Two engine facts that decide how fast a record copies, which set how \`intern\` builds canonical records and how
\`produce\` copies a draft. (1) An object grown by assigning keys one at a time into \`{}\` leaves fast-properties
mode at ~20 keys on V8; \`Object.fromEntries\` stays fast at any width — the first rows probe the mode where the
runtime exposes it (\`--allow-natives-syntax\`; otherwise they are omitted). (2) Object spread is an inline cache: a
memcpy while the site has seen ≤4 shapes, a per-property generic fallback after, and a library's single copy site
sees every shape in an application; \`Object.assign\` keys on the source map and stays fast at a megamorphic site.
Copy rows are for frozen fast-mode sources of 3, 20, 100 and 1,000 keys.
`,
  columns: ['spread, ≤4 shapes', 'spread, megamorphic', 'Object.assign, megamorphic'],
  unit: 'ns',
  rows() {
    const rows = [];
    let natives = null;
    try {
      natives = new Function('o', 'return %HasFastProperties(o)');
      natives({});
    } catch {
      natives = null;
    }
    if (natives !== null) {
      for (const n of [12, 20, 128, 1000]) {
        const keys = Array.from({ length: n }, (_, i) => `k${i}`).sort();
        const grown = {};
        for (const k of keys) grown[k] = 1;
        const built = Object.fromEntries(keys.map((k) => [k, 1]));
        rows.push(row(`fast-properties mode at ${n} keys: key-by-key ${natives(grown)}, fromEntries ${natives(built)}`, { 'spread, ≤4 shapes': null, 'spread, megamorphic': null, 'Object.assign, megamorphic': null }));
      }
    }
    const shapes = Array.from({ length: 12 }, (_, s) => Object.freeze(Object.fromEntries(Array.from({ length: 5 + s }, (_, i) => [`s${s}_${i}`, i]))));
    const spreadSite = (o) => ({ ...o });
    const assignSite = (o) => Object.assign({}, o);
    const monoSpread = (o) => ({ ...o });
    for (const s of shapes) for (let i = 0; i < 100; i++) { spreadSite(s); assignSite(s); }
    for (const n of [3, 20, 100, 1000]) {
      const base = Object.freeze(Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, i])));
      const it = n >= 1000 ? 3000 : 20_000;
      rows.push(row(`copy a ${n}-key record`, { 'spread, ≤4 shapes': time(() => monoSpread(base), it), 'spread, megamorphic': time(() => spreadSite(base), it), 'Object.assign, megamorphic': time(() => assignSite(base), it) }));
    }
    return rows;
  },
};
