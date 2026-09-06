import { time, row } from '../lib.mjs';
import { HashMap } from '../../dist/hash-map.js';
import { FastMap } from '../../dist/fast-collections.js';
import { intern } from '../../dist/intern.js';

export default {
  id: 'hashmap',
  title: 'HashMap and FastMap — against a native Map',
  description: `
\`HashMap\` matches keys by content: a key is hashed (\`internHash\` — O(1) on a canonical key, a walk on a raw one) and
compared structurally in a bucket table, and stored as given. \`FastMap\` is a native \`Map\` that admits canonical keys
only, where reference equality already is value equality: the canonical check costs a probe while checks are on, and
after \`skipChecks()\` the constructor returns a plain \`Map\`. Rows are hits on a 4,096-entry map unless marked; the
native \`Map\` column is what \`FastMap\` becomes with checks off.
`,
  columns: ['HashMap', 'FastMap (checks on)', 'native Map'],
  unit: 'ns',
  rows() {
    const rows = [];
    const keys = Array.from({ length: 4096 }, (_, i) => intern({ table: 'users', id: i }));
    const fill = (m) => { for (let i = 0; i < keys.length; i++) m.set(keys[i], i); return m; };
    const h = fill(new HashMap()), f = fill(new FastMap()), n = fill(new Map());
    const it = 300_000;
    rows.push(row('get, canonical object key', { HashMap: time((i) => h.get(keys[i & 4095]), it), 'FastMap (checks on)': time((i) => f.get(keys[i & 4095]), it), 'native Map': time((i) => n.get(keys[i & 4095]), it) }));
    rows.push(row('get, primitive key', { HashMap: time((i) => h.get(i & 4095), it), 'FastMap (checks on)': time((i) => f.get(i & 4095), it), 'native Map': time((i) => n.get(i & 4095), it) }));
    rows.push(row('get, raw 2-key object (a walk; FastMap rejects, Map misses)', { HashMap: time((i) => h.get({ table: 'users', id: i & 4095 }), it), 'FastMap (checks on)': null, 'native Map': null }));
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, v: i }));
    h.set({ items: big }, 1);
    rows.push(row('get, raw 50-record payload key', { HashMap: time(() => h.get({ items: big.map((x) => ({ ...x })) }), 20_000), 'FastMap (checks on)': null, 'native Map': null }));
    const s = new HashMap();
    rows.push(row('set, a novel raw 2-key object per call', { HashMap: time((i) => s.set({ table: 'x', id: i }, 1), 100_000), 'FastMap (checks on)': null, 'native Map': null }));
    return rows;
  },
};
