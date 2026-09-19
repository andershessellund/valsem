import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { row } from '../lib.mjs';

const WORKER = fileURLToPath(new URL('./skip-freezing.worker.mjs', import.meta.url));
const COLUMNS = ['freezing on', 'skipFreezing()'];

export default {
  id: 'skip-freezing',
  title: 'skipFreezing() — what the switch buys, by engine',
  description: `
The same operations in two processes, one of which called \`skipFreezing()\` first (it is a one-way switch per process,
so each column is a child process of its own). Freezing is on by default and stays on: a stray mutation of canonical
state throws instead of corrupting every holder of the value. What it costs depends on the engine, which is why this
table matters more in one column of the header than in the other.

- On **SpiderMonkey** (Firefox) the switch buys nothing: the freeze is cheap and a frozen array reads at full speed.
- On **V8** (Node, Chrome) \`Object.freeze\` is a map transition, so valsem's own operations barely move (an edit in a
  large plain array gains a little, since a frozen array is slower to copy). What the switch buys is in *your* code:
  V8 has no fast path for frozen elements in several builtins, so loops over canonical arrays run 2–3× faster
  unfrozen.
- On **JavaScriptCore** (Safari, Bun) freezing an array is an O(n) walk, and \`produce\` freezes the new array of every
  edit: one edit in a 10,000-element plain array is milliseconds with freezing on and microseconds without. An app
  that keeps large plain arrays in state and runs on Safari should call \`skipFreezing()\` in production (freeze in
  development and test, as with immer), or hold those sequences in a \`ValueList\`, whose leaves are small arrays
  inside a frozen wrapper and which pays neither cost: the \`ValueList\` rows do not move on either engine.
`,
  columns: COLUMNS,
  unit: 'ns',
  ratio: ['skipFreezing()', 'freezing on'],
  rows() {
    const run = (mode) => JSON.parse(execFileSync(process.execPath, [WORKER, mode], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop());
    return rowsWith(run);
  },
};

/**
 * The rows, given a way to run the worker in one mode ('on' | 'off') and get
 * its { name: ns } back: this runtime's own executable above, the
 * SpiderMonkey shell in run-spidermonkey.mjs.
 *
 * Three processes per column, alternating, best per row. Within a process the
 * worker already takes the best of several repetitions, but some rows are
 * bimodal BETWEEN processes (the same edit settles at 3.7 µs or at 8 µs for a
 * whole process, whichever column it is), and one process per column would
 * print that as a difference the switch does not make.
 */
export function rowsWith(run) {
  const best = { on: {}, off: {} };
  for (let round = 0; round < 3; round++) {
    for (const mode of ['on', 'off']) {
      for (const [name, ns] of Object.entries(run(mode))) best[mode][name] = Math.min(best[mode][name] ?? Infinity, ns);
    }
  }
  return Object.keys(best.on).map((name) => row(name, { [COLUMNS[0]]: best.on[name], [COLUMNS[1]]: best.off[name] ?? null }));
}

export const WORKER_PATH = WORKER;
