// ---------------------------------------------------------------------------
// The benchmark engines other than Node, at PINNED versions: Bun
// (JavaScriptCore) and Mozilla's SpiderMonkey shell (Firefox's engine).
//
//   node bench/fetch-engines.mjs            fetch what is missing, print the paths
//
// bench/engines.json names the versions. Each is downloaded from its vendor
// (Bun's GitHub releases, archive.mozilla.org), checked against the vendor's
// published checksums, and unpacked under node_modules/.cache/valsem-bench/,
// which is local to the checkout, ignored by git and gone with node_modules.
//
// Why not devDependencies: Mozilla publishes no npm package of the shell, and
// Bun's is a 60 MB binary with a postinstall script that every `pnpm install`
// would then pay for and run, CI and the release job (which holds the npm
// identity) included, for something only `pnpm bench` uses. Why pinned at
// all: `npx bun@latest` measured whatever was newest that day. An engine is
// bumped here, in the same change that re-records the numbers, so
// BENCHMARKS.md always matches what `pnpm bench` runs.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PINS = JSON.parse(readFileSync(new URL('./engines.json', import.meta.url), 'utf8'));
const CACHE = fileURLToPath(new URL('../node_modules/.cache/valsem-bench/', import.meta.url));

const key = `${process.platform}-${process.arch}`;
const ENGINES = {
  bun: {
    asset: { 'darwin-arm64': 'bun-darwin-aarch64', 'darwin-x64': 'bun-darwin-x64', 'linux-x64': 'bun-linux-x64', 'linux-arm64': 'bun-linux-aarch64', 'win32-x64': 'bun-windows-x64' }[key],
    url: (v, asset) => `https://github.com/oven-sh/bun/releases/download/bun-v${v}/${asset}.zip`,
    sums: (v) => `https://github.com/oven-sh/bun/releases/download/bun-v${v}/SHASUMS256.txt`,
    sumsLine: (asset) => `${asset}.zip`,
    algorithm: 'sha256',
    binary: (dir, asset) => join(dir, asset, process.platform === 'win32' ? 'bun.exe' : 'bun'),
  },
  spidermonkey: {
    asset: { 'darwin-arm64': 'jsshell-mac', 'darwin-x64': 'jsshell-mac', 'linux-x64': 'jsshell-linux-x86_64', 'linux-arm64': 'jsshell-linux-aarch64', 'win32-x64': 'jsshell-win64', 'win32-arm64': 'jsshell-win64-aarch64' }[key],
    url: (v, asset) => `https://archive.mozilla.org/pub/firefox/releases/${v}/jsshell/${asset}.zip`,
    sums: (v) => `https://archive.mozilla.org/pub/firefox/releases/${v}/SHA512SUMS`,
    sumsLine: (asset) => `jsshell/${asset}.zip`,
    algorithm: 'sha512',
    binary: (dir) => join(dir, process.platform === 'win32' ? 'js.exe' : 'js'),
  },
};

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The path of engine `name`'s binary at its pinned version, fetched and verified on first use. */
export async function enginePath(name) {
  const engine = ENGINES[name];
  const version = PINS[name];
  if (engine === undefined || version === undefined) throw new Error(`valsem bench: no engine '${name}' in bench/engines.json`);
  if (engine.asset === undefined) throw new Error(`valsem bench: no ${name} build is known for ${key}; see bench/fetch-engines.mjs`);
  const dir = join(CACHE, `${name}-${version}`);
  const binary = engine.binary(dir, engine.asset);
  if (existsSync(join(dir, '.verified')) && existsSync(binary)) return binary;

  process.stderr.write(`valsem bench: fetching ${name} ${version} (${engine.asset}) …\n`);
  let zip, sums;
  try {
    [zip, sums] = await Promise.all([download(engine.url(version, engine.asset)), download(engine.sums(version))]);
  } catch (e) {
    throw new Error(`valsem bench: could not fetch ${name} ${version}: ${e.message}. The benchmarks run on pinned engines (bench/engines.json), so there is no fallback to whatever is installed.`);
  }
  // The vendor's checksum file: "<hex>  <file>" per line. No match, no run.
  const wanted = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === engine.sumsLine(engine.asset) || p[1] === `*${engine.sumsLine(engine.asset)}`)?.[0];
  const actual = createHash(engine.algorithm).update(zip).digest('hex');
  if (wanted === undefined || wanted.toLowerCase() !== actual) {
    throw new Error(`valsem bench: ${name} ${version} failed its checksum (${engine.algorithm}: expected ${wanted ?? 'an entry in the vendor\'s checksum file'}, got ${actual})`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, 'download.zip');
  writeFileSync(archive, zip);
  try {
    execFileSync('unzip', ['-oq', archive, '-d', dir]);
  } catch {
    execFileSync('tar', ['-xf', archive, '-C', dir]); // bsdtar (macOS, Windows) reads zip
  }
  rmSync(archive);
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
  writeFileSync(join(dir, '.verified'), `${engine.algorithm}:${actual}\n`);
  return binary;
}

export const pins = PINS;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of Object.keys(PINS)) console.log(`${name} ${PINS[name]}: ${await enginePath(name)}`);
}
