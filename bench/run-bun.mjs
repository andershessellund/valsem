// Run bench/run.mjs under the pinned Bun (bench/engines.json), arguments passed through.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enginePath } from './fetch-engines.mjs';

const bun = await enginePath('bun');
const { status } = spawnSync(bun, [fileURLToPath(new URL('./run.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
