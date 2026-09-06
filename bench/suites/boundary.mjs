import { time, row, isBun } from '../lib.mjs';
import { intern } from '../../dist/intern.js';
import { ValueList } from '../../dist/value-list.js';
import { produce as immerProduce, setAutoFreeze } from 'immer';

const F = 10;
const record = (i, salt = 0) => {
  const r = { id: i + salt * 1e6, name: `user-${i}`, email: `user${i}@example.com`, active: i % 3 !== 0, score: i * 1.5 };
  for (let f = Object.keys(r).length; f < F; f++) r[`field${f}`] = f % 2 ? `v${i}-${f}` : i * f;
  return r;
};

export default {
  id: 'boundary',
  title: 'The boundary — admitting raw data',
  description: `
What it costs to make an API response canonical: an array of N records with ${F} fields each (five strings, four
numbers, a boolean), as \`JSON.parse\` delivers it. Rows per size:

- **JSON.parse** of the same payload — a cost the application pays anyway; the yardstick.
- **structuredClone** and **immer's auto-freeze walk** (\`produce(data, () => {})\`) — the cheapest "make it
  immutable" walks a frontend runs today.
- **intern, all new content** — every record is novel: hashed, copied, pooled, frozen.
- **intern, unchanged refetch** — the same content arrives again; every record finds its pool entry and no copy is built.
- **intern, 10% changed** — a refetch with every tenth record different.
- **ValueList.from** of the same records — the list structure on top of admission.

Values are per response; divide by N for the per-record cost. At 100 Mbit with 80% compression, the 1k response
transfers in ~2.7 ms and the 10k one in ~27 ms, off the main thread; admission runs on it.
`,
  columns: ['per response'],
  unit: 'ns',
  rows() {
    const rows = [];
    for (const N of [1000, 10_000]) {
      const response = (salt) => Array.from({ length: N }, (_, i) => record(i, salt));
      const text = JSON.stringify(response());
      const it = N === 1000 ? 60 : 12;
      const tag = `${N} × ${F}`;
      rows.push(row(`${tag}: JSON.parse`, { 'per response': time(() => JSON.parse(text), it * 3) }));
      const parsed = Array.from({ length: it }, () => JSON.parse(text));
      let k = 0;
      rows.push(row(`${tag}: structuredClone`, { 'per response': time(() => structuredClone(parsed[k++ % it]), it) }));
      setAutoFreeze(true);
      const forImmer = Array.from({ length: it }, () => JSON.parse(text));
      k = 0;
      rows.push(row(`${tag}: immer auto-freeze walk`, { 'per response': time(() => immerProduce(forImmer[k++ % it], () => {}), it) }));
      let salt = 1000 + N;
      const fresh = Array.from({ length: it }, () => response(salt++));
      k = 0;
      rows.push(row(`${tag}: intern, all new content`, { 'per response': time(() => intern(fresh[k++ % it]), it) }));
      intern(response(0));
      const same = Array.from({ length: it }, () => JSON.parse(text));
      k = 0;
      rows.push(row(`${tag}: intern, unchanged refetch (all pool hits)`, { 'per response': time(() => intern(same[k++ % it]), it) }));
      let salt2 = 5000 + N;
      const partly = Array.from({ length: it }, () => { const r = response(0); for (let i = 0; i < N; i += 10) r[i] = record(i, salt2); salt2++; return r; });
      k = 0;
      rows.push(row(`${tag}: intern, refetch with 10% of records changed`, { 'per response': time(() => intern(partly[k++ % it]), it) }));
      const freshL = Array.from({ length: it }, () => response(salt++));
      k = 0;
      rows.push(row(`${tag}: ValueList.from, all new content`, { 'per response': time(() => ValueList.from(freshL[k++ % it]), it) }));
      const canon = intern(response(0));
      rows.push(row(`${tag}: ValueList.from, canonical records (the list alone)`, { 'per response': time(() => ValueList.from(canon), it) }));
    }
    if (isBun) {
      /* same rows; nothing runtime-specific */
    }
    return rows;
  },
};
