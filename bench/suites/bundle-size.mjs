import { row, isBun } from '../lib.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
  id: 'bundle-size',
  title: 'Bundle size',
  description: `
esbuild, minified ESM, importing through the package name so \`exports\` and \`sideEffects\` are honoured; gzip at
level 9. Each row bundles one import (or a set) and nothing else. immer, mutative and Immutable.js rows are the
comparable entry points of those libraries. Node only.
`,
  columns: ['minified', 'gzipped'],
  unit: 'bytes',
  rows() {
    if (isBun) return [];
    const root = new URL('../../', import.meta.url).pathname;
    const pnpmDir = join(root, 'node_modules/.pnpm');
    const esbuildDir = existsSync(pnpmDir) ? readdirSync(pnpmDir).filter((d) => d.startsWith('esbuild@')).sort().pop() : undefined;
    if (esbuildDir === undefined) return [];
    const esbuild = join(pnpmDir, esbuildDir, 'node_modules/esbuild/bin/esbuild');
    const dir = mkdtempSync(join(tmpdir(), 'valsem-bundle-'));
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(root, join(dir, 'node_modules/valsem'));
    for (const lib of ['immer', 'mutative', 'immutable']) symlinkSync(join(root, 'node_modules', lib), join(dir, 'node_modules', lib));
    const rows = [];
    const measure = (name, code) => {
      const entry = join(dir, 'entry.mjs');
      const out = join(dir, 'out.js');
      writeFileSync(entry, code);
      execFileSync(esbuild, [entry, '--bundle', '--minify', '--format=esm', `--outfile=${out}`, '--log-level=error']);
      const buf = readFileSync(out);
      rows.push(row(name, { minified: buf.length, gzipped: gzipSync(buf, { level: 9 }).length }));
    };
    for (const names of ['produce', 'produce, current, original', 'deepEqual', 'intern', 'HashMap', 'ValueMap', 'ValueList', 'memoize']) {
      measure(`valsem: ${names}`, `import { ${names} } from 'valsem'; console.log(${names});`);
    }
    measure('valsem: everything', "import * as v from 'valsem'; console.log(v);");
    measure('immer: produce', "import { produce } from 'immer'; console.log(produce);");
    measure('immer: produce + enableMapSet', "import { produce, enableMapSet } from 'immer'; enableMapSet(); console.log(produce);");
    measure('mutative: create', "import { create } from 'mutative'; console.log(create);");
    measure('Immutable.js: Map', "import { Map } from 'immutable'; console.log(Map);");
    return rows;
  },
};
