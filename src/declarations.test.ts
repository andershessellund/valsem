// ---------------------------------------------------------------------------
// The PUBLISHED declarations, compiled the way a consumer compiles them.
//
// `pnpm typecheck` reads the source, and the source can typecheck where the
// declarations emitted from it do not: TypeScript measures a class's variance
// differently from a `.d.ts`, and a conditional type (`Draft<V>`) in a
// return position hid `V` from that measurement, so `OrderedMap<string,
// number>` was not assignable to `OrderedMap<string, unknown>` for consumers
// while every check in this repository passed. So this suite emits the
// declarations in memory and compiles a consumer file against them, under
// the floor docs/guide/requirements.md promises: `lib: ES2015`, with
// `skipLibCheck` OFF, so the declarations themselves are checked too.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Emit `src/` as declarations, in memory: path of the `.d.ts` → its text. */
function emitDeclarations(): Map<string, string> {
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

/** Compile `source` as `/consumer/main.ts` against the emitted declarations; the diagnostics, as text. */
function compileConsumer(declarations: Map<string, string>, source: string): string[] {
  const files = new Map(declarations);
  files.set('/consumer/main.ts', source);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2015.d.ts'],
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
  const program = ts.createProgram(['/consumer/main.ts'], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

describe('the published declarations, as a consumer compiles them', () => {
  const declarations = emitDeclarations();

  it('compile under lib ES2015 with skipLibCheck off, and every collection is covariant', () => {
    const diagnostics = compileConsumer(
      declarations,
      `
      import { ValueList, ValueMap, ValueSet, OrderedMap, OrderedSet, HashMap, HashSet, RawArray,
        DraftList, DraftMap, DraftSet, DraftOrderedMap, DraftOrderedSet, produce } from '/published/index.js';

      declare const list: ValueList<number>;           export const a: ValueList<unknown> = list;
      declare const map: ValueMap<string, number>;     export const b: ValueMap<unknown, unknown> = map;
      declare const set: ValueSet<number>;             export const c: ValueSet<unknown> = set;
      declare const omap: OrderedMap<string, number>;  export const d: OrderedMap<unknown, unknown> = omap;
      declare const oset: OrderedSet<number>;          export const e: OrderedSet<unknown> = oset;
      declare const raw: RawArray<number>;             export const f: RawArray<unknown> = raw;
      declare const hmap: HashMap<string, number>;     export const g: HashMap<unknown, unknown> = hmap;
      declare const hset: HashSet<number>;             export const h: HashSet<unknown> = hset;
      declare const dl: DraftList<number>;             export const i: DraftList<unknown> = dl;
      declare const dm: DraftMap<string, number>;      export const j: DraftMap<unknown, unknown> = dm;
      declare const ds: DraftSet<number>;              export const k: DraftSet<unknown> = ds;
      declare const dom: DraftOrderedMap<string, number>; export const l: DraftOrderedMap<unknown, unknown> = dom;
      declare const dos: DraftOrderedSet<number>;      export const m: DraftOrderedSet<unknown> = dos;

      // ...and the spelling that keeps them covariant costs the caller nothing:
      interface Todo { readonly done: boolean }
      produce({ l: ValueList.of<Todo>({ done: false }), m: OrderedMap.from<string, Todo>([['k', { done: false }]]) }, (draft) => {
        draft.l.get(0).done = true;
        draft.m.at(0)[1].done = true;
        const first = draft.m.first();
        if (first !== undefined) first[1].done = true;
      });
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  it('the harness can fail: a wrong assignment is reported', () => {
    const diagnostics = compileConsumer(
      declarations,
      `import { ValueList } from '/published/index.js';
       declare const list: ValueList<unknown>;
       export const narrowed: ValueList<number> = list;`,
    );
    expect(diagnostics.join('\\n')).toMatch(/not assignable/);
  });
});
