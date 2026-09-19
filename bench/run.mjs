// ---------------------------------------------------------------------------
// Run the benchmark suites and write bench/results/<runtime>.json.
//
//   node bench/run.mjs [suite-id ...]        (all suites when none given)
//   npx bun@latest bench/run.mjs [suite-id ...]
//
// Then `node bench/report.mjs` renders BENCHMARKS.md from the JSON files.
//
// A run is refused when the code measured is not the commit it would record:
// uncommitted changes, or a dist/ older than src/ (the suites import dist/).
// `--allow-dirty` runs anyway, for work in progress, and marks the commit
// `-dirty`. Every suite carries its own commit and date, since a partial run
// merges into the existing file and must not restamp what it did not measure.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { environment, provenanceProblems, runtime, settle } from './lib.mjs';

const SUITES = [
  'produce',
  'boundary',
  'equality',
  'collections',
  'hashmap',
  'memoize',
  'list',
  'list-draft',
  'ordered',
  'frozen-array',
  'skip-freezing',
  'record-copy',
  'bundle-size',
];

// `--child <suite>`: run one suite and print its rows for the parent (see `processes` below).
const CHILD_MARK = '@@valsem-bench-rows ';
const child = process.argv.includes('--child');

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ids = wanted.length === 0 ? SUITES : wanted;
const outPath = new URL(`./results/${runtime.name}.json`, import.meta.url);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });

// Partial runs merge into the existing file, so a single suite can be re-run.
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { suites: [] };
const problems = child ? [] : provenanceProblems(); // the parent has checked
if (problems.length !== 0 && !process.argv.includes('--allow-dirty')) {
  console.error(`valsem bench: refusing to record results, the code measured would not be the commit recorded:\n  - ${problems.join('\n  - ')}\nCommit and build first, or pass --allow-dirty (the commit is then recorded as -dirty).`);
  process.exit(1);
}
const env = environment();
if (!child) console.log(`valsem bench — ${env.runtime.name} ${env.runtime.version} (${env.runtime.engine}), ${env.machine.cpu}, commit ${env.commit}`);

/**
 * A suite that declares `processes: n` is run in n processes of its own and
 * reports the MEDIAN of each cell. The hash seed is drawn per process, and
 * the shape of a content-chunked list or an anchor trie follows the hashes:
 * measured here, `OrderedMap.delete` at 10k keys ranges 28–46 µs across
 * seeds with no code change, so one process is one draw, not the number.
 */
function medianRows(id, n) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    const out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', id], { encoding: 'utf8', maxBuffer: 2 ** 26 });
    const line = out.split('\n').find((l) => l.startsWith(CHILD_MARK));
    if (line === undefined) throw new Error(`bench: the child process for ${id} printed no rows`);
    runs.push(JSON.parse(line.slice(CHILD_MARK.length)));
  }
  const median = (xs) => {
    const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (s.length === 0) return xs[0] ?? null;
    return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  return runs[0].map((row, r) => {
    const values = {};
    for (const c of Object.keys(row.values)) values[c] = median(runs.map((rows) => rows[r].values[c]));
    return { ...row, values };
  });
}

const fmt = (v) => (v === null || v === undefined ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(2)} ms` : v >= 1000 ? `${(v / 1000).toFixed(1)} µs` : `${v.toFixed(0)} ns`);
const results = [];
for (const id of ids) {
  const mod = await import(`./suites/${id}.mjs`);
  const suite = mod.default;
  await settle();
  const t0 = Date.now();
  process.stdout.write(`\n## ${suite.title}\n`);
  const processes = child ? 1 : (suite.processes ?? 1);
  const rows = processes > 1 ? medianRows(id, processes) : await suite.rows();
  if (child) {
    console.log(CHILD_MARK + JSON.stringify(rows));
    process.exit(0);
  }
  for (const r of rows) {
    const cells = suite.columns.map((c) => `${c}: ${suite.unit === 'ns' ? fmt(r.values[c]) : r.values[c] === null || r.values[c] === undefined ? '—' : r.values[c]}`).join('   ');
    console.log(`  ${r.name.padEnd(48)} ${cells}`);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  results.push({ id, title: suite.title, description: suite.description, columns: suite.columns, unit: suite.unit, ratio: suite.ratio ?? null, processes, commit: env.commit, date: env.date, rows });
}
const merged = previous.suites.filter((s) => !ids.includes(s.id));
for (const r of results) merged.push(r);
merged.sort((a, b) => SUITES.indexOf(a.id) - SUITES.indexOf(b.id));
writeFileSync(outPath, JSON.stringify({ ...env, suites: merged }, null, 2));
console.log(`\nwrote ${outPath.pathname}`);
