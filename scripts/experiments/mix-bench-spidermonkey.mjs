// Run mix-bench-shell.mjs under the pinned SpiderMonkey shell (bench/engines.json),
// every measurement its own process, and print a table: the registry pool this
// design replaced (`fr`) against the built one (`shipped`).
//
//   pnpm build && node scripts/experiments/mix-bench-spidermonkey.mjs [rounds]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enginePath } from '../../bench/fetch-engines.mjs';

const shell = process.env.SPIDERMONKEY_SHELL || (await enginePath('spidermonkey'));
const version = execFileSync(shell, ['--version'], { encoding: 'utf8' }).trim().replace(/^JavaScript-C/, '');
const SCRIPT = fileURLToPath(new URL('./mix-bench-shell.mjs', import.meta.url));
const rounds = Number(process.argv[2] ?? 2);
const SCENARIOS = ['churn 50k, no hits', 'churn 50k, 4 hits/ins', 'churn 1M, no hits', 'churn 1M, 4 hits/ins', 'grow to 2M, no deaths'];
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

console.log(`spidermonkey ${version}, ${rounds} rounds, median (min–max for ns/op)\n`);
for (const scenario of SCENARIOS) {
  console.log(`## ${scenario}`);
  console.log('pool         ns/op (min–max)      gc ms   max batch    stored   after settle');
  for (const pool of ['fr', 'shipped']) {
    const rs = [];
    for (let r = 0; r < rounds; r++) {
      const out = execFileSync(shell, ['-m', SCRIPT, '--', pool, scenario], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop();
      rs.push(JSON.parse(out));
    }
    const ns = rs.map((r) => r.nsPerOp);
    console.log(
      `${pool.padEnd(10)} ${med(ns).toFixed(0).padStart(6)} (${Math.min(...ns).toFixed(0)}–${Math.max(...ns).toFixed(0)})`.padEnd(34) +
        `${med(rs.map((r) => r.gcMs)).toFixed(0).padStart(6)} ${med(rs.map((r) => r.maxBatch)).toFixed(1).padStart(10)} ${String(med(rs.map((r) => r.stored))).padStart(9)} ${String(med(rs.map((r) => r.storedAfterSettle))).padStart(12)}`,
    );
  }
  console.log('');
}
