// ---------------------------------------------------------------------------
// Shared benchmark helpers. Every suite exports { id, title, description,
// columns, unit, rows: run() } and uses these to time and to build rows.
// ---------------------------------------------------------------------------
import os from 'node:os';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

export const isBun = typeof Bun !== 'undefined';
export const runtime = isBun
  ? { name: 'bun', version: Bun.version, engine: 'JavaScriptCore' }
  : { name: 'node', version: process.version.slice(1), engine: 'V8' };

export { time, timeHeld, row, shuffled, assertEq } from './timing.mjs';
import { time } from './timing.mjs';

/**
 * Let the process settle: yield a few hundred turns and collect. The end of
 * a turn is what releases the targets of every WeakRef created in it (the
 * kept-objects list; valsem makes one per canonical object and trie node),
 * and the idle turns are when the pool drains its parked slots. Without it,
 * a synchronous `rows()` is ONE job: every row's garbage stays alive to the
 * end of the suite, and each row pays GC for all the rows before it.
 */
export async function settle() {
  const gc = globalThis.gc ?? (typeof Bun !== 'undefined' ? () => Bun.gc(true) : null);
  for (let round = 0; round < 3; round++) {
    gc?.();
    for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
  }
  gc?.();
}

/** {@link time}, in a job of its own on a settled heap: what one row should measure. */
export async function timeSettled(fn, iterations, warmup, prepare) {
  await settle();
  // A row whose premise is engine state (a call site that has seen many
  // shapes) sets it up here, after the settle and right before the clock:
  // state left behind by earlier rows is an accident, and does not survive.
  if (prepare !== undefined) prepare();
  return warmup === undefined ? time(fn, iterations) : time(fn, iterations, warmup);
}

/**
 * Is the measured code what the recorded commit says it is? Two ways it was
 * not, both of which put wrong provenance into BENCHMARKS.md once:
 *
 *   - uncommitted changes (the file claimed a commit that predated a feature
 *     it measured). What a run writes itself, bench/results and
 *     BENCHMARKS.md, does not count: `pnpm bench` runs Node, then Bun;
 *   - a stale build. The suites import dist/, which is not tracked, so a
 *     clean tree says nothing about it: every src module must be no newer
 *     than its compiled file.
 *
 * Returns the reasons, empty when the run is honest.
 */
export function provenanceProblems() {
  const problems = [];
  try {
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter((l) => l.trim() !== '' && !/^.. (bench\/results\/|BENCHMARKS\.md$)/.test(l));
    if (dirty.length !== 0) problems.push(`uncommitted changes (${dirty.length} path${dirty.length === 1 ? '' : 's'}, first: ${dirty[0].slice(3)})`);
  } catch {
    /* not a git checkout: nothing to compare with */
  }
  const src = new URL('../src/', import.meta.url);
  const dist = new URL('../dist/', import.meta.url);
  for (const name of readdirSync(src)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.test-helpers.ts')) continue;
    const built = new URL(name.replace(/\.ts$/, '.js'), dist);
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(new URL(name, src)).mtimeMs) {
      problems.push(`dist/ is older than src/${name}: run \`pnpm build\``);
      break;
    }
  }
  return problems;
}

export function environment() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  if (provenanceProblems().length !== 0) commit += '-dirty'; // only reachable with --allow-dirty
  const version = (name) => {
    try {
      return JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
    } catch {
      return 'n/a';
    }
  };
  return {
    runtime,
    machine: { cpu: os.cpus()[0]?.model ?? 'unknown', platform: `${os.platform()} ${os.arch()}` },
    date: new Date().toISOString().slice(0, 10),
    commit,
    valsem: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    libraries: { immer: version('immer'), mutative: version('mutative'), immutable: version('immutable'), 'fast-deep-equal': version('fast-deep-equal') },
  };
}
