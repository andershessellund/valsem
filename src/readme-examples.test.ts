// ---------------------------------------------------------------------------
// Every TypeScript block in README.md compiles under `strict`, on its own,
// against the published declarations. The README is the first thing a reader
// pastes, so an example that cannot compile is a defect (the 1.0.0 review
// found one). Each block is a module of its own (`.mts`, so a top-level
// `await` is allowed), compiled with the DOM lib for `fetch`, and `valsem`
// resolves to the emitted declarations.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitDeclarations, compileConsumer, SRC } from './declarations.test-helpers.js';

const readme = readFileSync(join(SRC, '../README.md'), 'utf8');
const blocks = [...readme.matchAll(/^```(?:ts|typescript)\n(.*?)^```/gms)].map((m) => ({
  line: readme.slice(0, m.index).split('\n').length,
  code: m[1]!,
}));

describe('README.md: every TypeScript block compiles under strict, on its own', () => {
  const declarations = emitDeclarations();

  it('finds the blocks', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10);
  });

  for (const { line, code } of blocks) {
    it(`the block at line ${line}`, () => {
      const source = code
        .replace(/from 'valsem\/([^']+)'/g, "from '/published/$1.js'")
        .replace(/from 'valsem'/g, "from '/published/index.js'");
      expect(source).not.toBe(code); // every block imports what it uses
      const diagnostics = compileConsumer(declarations, source, {
        fileName: '/consumer/block.mts',
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        target: ts.ScriptTarget.ES2022,
      });
      expect(diagnostics).toEqual([]);
    });
  }
});
