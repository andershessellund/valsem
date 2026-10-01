// ---------------------------------------------------------------------------
// The PUBLISHED declarations, compiled the way a consumer compiles them:
// emit `src/` as `.d.ts` in memory, then compile a consumer file against the
// emitted files. Shared by declarations.test.ts (the entry points, variance,
// what is stripped) and readme-examples.test.ts (every README block).
// ---------------------------------------------------------------------------
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SRC = dirname(fileURLToPath(import.meta.url));

/** Emit `src/` as declarations, in memory: path of the `.d.ts` → its text. */
export function emitDeclarations(): Map<string, string> {
  const config = ts.readConfigFile(join(SRC, '../tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(SRC, '..'));
  const out = new Map<string, string>();
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    outDir: '/published',
  });
  program.emit(undefined, (fileName, text) => out.set(fileName, text));
  return out;
}

export interface ConsumerOptions {
  /** The consumer file's name; `.mts` makes it an ES module (a top-level `await` is then allowed). Default `/consumer/main.ts`. */
  fileName?: string;
  /** The lib files to compile against. Default ES2015 alone: the floor docs/guide/requirements.md promises. */
  lib?: string[];
  target?: ts.ScriptTarget;
}

/**
 * Compile `source` as a consumer file against the emitted declarations, under
 * `strict`, with `skipLibCheck` OFF so the declarations themselves are
 * checked too; the diagnostics, as text (empty when it compiles).
 */
export function compileConsumer(declarations: Map<string, string>, source: string, opts: ConsumerOptions = {}): string[] {
  const fileName = opts.fileName ?? '/consumer/main.ts';
  const files = new Map(declarations);
  files.set(fileName, source);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: opts.target ?? ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: opts.lib ?? ['lib.es2015.d.ts'],
    skipLibCheck: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  host.directoryExists = (d) => d === '/published' || d === '/consumer' || (directoryExists?.call(host, d) ?? false);
  host.fileExists = (f) => files.has(f) || fileExists.call(host, f);
  host.readFile = (f) => files.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, languageVersion, ...rest) =>
    files.has(f) ? ts.createSourceFile(f, files.get(f)!, languageVersion, true) : getSourceFile.call(host, f, languageVersion, ...rest);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}
