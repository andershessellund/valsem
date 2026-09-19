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
import { environment, provenanceProblems, runtime } from './lib.mjs';

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
  'record-copy',
  'bundle-size',
];

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ids = wanted.length === 0 ? SUITES : wanted;
const outPath = new URL(`./results/${runtime.name}.json`, import.meta.url);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });

// Partial runs merge into the existing file, so a single suite can be re-run.
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { suites: [] };
const problems = provenanceProblems();
if (problems.length !== 0 && !process.argv.includes('--allow-dirty')) {
  console.error(`valsem bench: refusing to record results, the code measured would not be the commit recorded:\n  - ${problems.join('\n  - ')}\nCommit and build first, or pass --allow-dirty (the commit is then recorded as -dirty).`);
  process.exit(1);
}
const env = environment();
console.log(`valsem bench — ${env.runtime.name} ${env.runtime.version} (${env.runtime.engine}), ${env.machine.cpu}, commit ${env.commit}`);

/**
 * Between suites: let the process settle so one suite's garbage does not
 * tax the next. The intern pool parks dead slots and drains them in idle
 * time (setImmediate here), so a synchronous benchmark loop never drains;
 * yielding a few hundred turns and collecting twice puts every suite on the
 * same footing.
 */
async function settle() {
  const gc = globalThis.gc ?? (typeof Bun !== 'undefined' ? () => Bun.gc(true) : null);
  for (let round = 0; round < 3; round++) {
    gc?.();
    for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
  }
  gc?.();
}

const fmt = (v) => (v === null || v === undefined ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(2)} ms` : v >= 1000 ? `${(v / 1000).toFixed(1)} µs` : `${v.toFixed(0)} ns`);
const results = [];
for (const id of ids) {
  const mod = await import(`./suites/${id}.mjs`);
  const suite = mod.default;
  await settle();
  const t0 = Date.now();
  process.stdout.write(`\n## ${suite.title}\n`);
  const rows = await suite.rows();
  for (const r of rows) {
    const cells = suite.columns.map((c) => `${c}: ${suite.unit === 'ns' ? fmt(r.values[c]) : r.values[c] === null || r.values[c] === undefined ? '—' : r.values[c]}`).join('   ');
    console.log(`  ${r.name.padEnd(48)} ${cells}`);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  results.push({ id, title: suite.title, description: suite.description, columns: suite.columns, unit: suite.unit, ratio: suite.ratio ?? null, commit: env.commit, date: env.date, rows });
}
const merged = previous.suites.filter((s) => !ids.includes(s.id));
for (const r of results) merged.push(r);
merged.sort((a, b) => SUITES.indexOf(a.id) - SUITES.indexOf(b.id));
writeFileSync(outPath, JSON.stringify({ ...env, suites: merged }, null, 2));
console.log(`\nwrote ${outPath.pathname}`);
