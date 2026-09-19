// ---------------------------------------------------------------------------
// The engine-level suites on SpiderMonkey, Firefox's engine, through Mozilla's
// standalone shell. Writes bench/results/spidermonkey.json, which report.mjs
// renders as a third runtime.
//
//   SPIDERMONKEY_SHELL=/path/to/js node bench/run-spidermonkey.mjs
//
// Where the shell comes from: Mozilla publishes one with every Firefox release,
// https://archive.mozilla.org/pub/firefox/releases/<version>/jsshell/ , and
// `npx jsvu --engines=spidermonkey` installs it as ~/.jsvu/bin/spidermonkey.
// With no shell to be found this is a no-op that says so: `pnpm bench` must
// not fail on a machine without one.
//
// Only the suites whose per-engine claims the docs rest on, and which a shell
// measures honestly: CPU-bound, no comparison libraries, no event loop needed.
// A shell has no macrotasks, so the "held, one call per macrotask" regime of
// the produce suite, and the intern pool's idle-time cleanup, do not exist
// there; it is the engine, not the browser (as Bun is not Safari).
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { environment, provenanceProblems } from './lib.mjs';
import skipFreezing, { rowsWith, WORKER_PATH } from './suites/skip-freezing.mjs';
import frozenArray from './suites/frozen-array.mjs';

const shell = [process.env.SPIDERMONKEY_SHELL, `${homedir()}/.jsvu/bin/spidermonkey`, `${homedir()}/.jsvu/bin/sm`].find((p) => p && existsSync(p));
if (shell === undefined) {
  console.log('valsem bench — spidermonkey: no shell found (set SPIDERMONKEY_SHELL, or `npx jsvu --engines=spidermonkey`); skipped.');
  process.exit(0);
}
const problems = provenanceProblems();
if (problems.length !== 0 && !process.argv.includes('--allow-dirty')) {
  console.error(`valsem bench: refusing to record results, the code measured would not be the commit recorded:\n  - ${problems.join('\n  - ')}\nCommit and build first, or pass --allow-dirty (the commit is then recorded as -dirty).`);
  process.exit(1);
}

const inShell = (script, ...args) =>
  JSON.parse(execFileSync(shell, ['-m', script, '--', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop());
// `js --version` prints "JavaScript-C156.0".
const version = execFileSync(shell, ['--version'], { encoding: 'utf8' }).trim().replace(/^JavaScript-C/, '');
const env = { ...environment(), runtime: { name: 'spidermonkey', version, engine: 'SpiderMonkey shell' } };
console.log(`valsem bench — spidermonkey ${version} (${shell}), ${env.machine.cpu}, commit ${env.commit}`);

const SHELL_RUN = fileURLToPath(new URL('./shell-run.mjs', import.meta.url));
const measure = {
  'frozen-array': () => inShell(SHELL_RUN, 'frozen-array'),
  'skip-freezing': () => rowsWith((mode) => inShell(WORKER_PATH, mode)),
};
const suites = [];
for (const suite of [frozenArray, skipFreezing]) {
  const t0 = Date.now();
  process.stdout.write(`\n## ${suite.title}\n`);
  const rows = measure[suite.id]();
  console.log(`  ${rows.length} rows (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  suites.push({ id: suite.id, title: suite.title, description: suite.description, columns: suite.columns, unit: suite.unit, ratio: suite.ratio ?? null, commit: env.commit, date: env.date, rows });
}
const outPath = new URL('./results/spidermonkey.json', import.meta.url);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...env, suites }, null, 2));
console.log(`\nwrote ${outPath.pathname}`);
