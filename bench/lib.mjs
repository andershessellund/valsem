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

/** Nanoseconds per call of `fn(i)` over `iterations`, after a warm-up. */
export function time(fn, iterations, warmup = Math.min(2000, Math.max(3, iterations / 5))) {
  for (let i = 0; i < warmup; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / iterations;
}

/**
 * Nanoseconds per call under the honest regime for update libraries: the
 * result is retained (a ring of 50), and one call runs per macrotask so
 * WeakRef kept-objects are released between calls. The yield cost is
 * measured and subtracted.
 */
export async function timeHeld(fn, iterations) {
  const yieldTask = () => new Promise((r) => setImmediate(r));
  const ring = new Array(50);
  for (let i = 0; i < Math.min(200, iterations); i++) {
    ring[i % 50] = fn(i);
    await yieldTask();
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    ring[i % 50] = fn(i);
    await yieldTask();
  }
  const total = Number(process.hrtime.bigint() - t0) / iterations;
  const y0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await yieldTask();
  const yieldCost = Number(process.hrtime.bigint() - y0) / iterations;
  return Math.max(0, total - yieldCost);
}

/** A row: `values` maps column label → number (in the suite's unit) or null. */
export function row(name, values, note) {
  return note === undefined ? { name, values } : { name, values, note };
}

/** Deterministic shuffle (LCG), so "independently built" means a different insertion order. */
export function shuffled(arr, seed = 1) {
  const out = arr.slice();
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function assertEq(a, b, what = '') {
  if (a !== b) throw new Error(`result mismatch ${what}: ${String(a)} vs ${String(b)}`);
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
