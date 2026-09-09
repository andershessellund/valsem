import { time, row } from '../lib.mjs';
import { HashMap } from '../../dist/hash-map.js';
import { intern } from '../../dist/intern.js';

export default {
  id: 'hashmap',
  title: 'HashMap — against a native Map',
  description: `
\`HashMap\` is a native \`Map\` keyed by canonical values: every key is interned on the way in, on \`set\` and on every
lookup. For a canonical key that is one cache probe over the native lookup; for a raw key it is a pool lookup (hash
and compare), and a copy into the pool when the key is new. Rows are hits on a 4,096-entry map unless marked. The
native \`Map\` column is the same map with keys interned beforehand — the escape hatch for the last nanoseconds.
`,
  columns: ['HashMap', 'native Map'],
  unit: 'ns',
  rows() {
    const rows = [];
    const keys = Array.from({ length: 4096 }, (_, i) => intern({ table: 'users', id: i }));
    const fill = (m) => { for (let i = 0; i < keys.length; i++) m.set(keys[i], i); return m; };
    const h = fill(new HashMap()), n = fill(new Map());
    const it = 300_000;
    rows.push(row('get, canonical object key', { HashMap: time((i) => h.get(keys[i & 4095]), it), 'native Map': time((i) => n.get(keys[i & 4095]), it) }));
    rows.push(row('get, primitive key', { HashMap: time((i) => h.get(i & 4095), it), 'native Map': time((i) => n.get(i & 4095), it) }));
    rows.push(row('set, existing canonical key', { HashMap: time((i) => h.set(keys[i & 4095], i), it), 'native Map': time((i) => n.set(keys[i & 4095], i), it) }));
    rows.push(row('get, raw 2-key object (interned first; a native Map misses)', { HashMap: time((i) => h.get({ table: 'users', id: i & 4095 }), it), 'native Map': null }));
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, v: i }));
    h.set({ items: big }, 1);
    rows.push(row('get, raw 50-record payload key', { HashMap: time(() => h.get({ items: big.map((x) => ({ ...x })) }), 20_000), 'native Map': null }));
    const s = new HashMap();
    rows.push(row('set, a novel raw 2-key object per call (a pool entry each)', { HashMap: time((i) => s.set({ table: 'x', id: i }, 1), 100_000), 'native Map': null }));
    return rows;
  },
};
