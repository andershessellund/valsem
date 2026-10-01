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
import { emitDeclarations, compileConsumer } from './declarations.test-helpers.js';

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
        draft.l.at(-1)!.done = true;
        draft.m.at(-1)![1].done = true;
        const first = draft.m.first();
        if (first !== undefined) first[1].done = true;
      });
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  it("the drafts' bookkeeping is not reachable from the published types: a renamed field breaks no consumer", () => {
    const diagnostics = compileConsumer(
      declarations,
      `
      import { ValueList, DraftOrderedMap, toDraft } from '/published/index.js';
      import { DRAFT_STATE } from '/published/draft.js';
      // @ts-expect-error ListState.overlay is internal
      export type ListOverlay = ReturnType<ValueList<number>[typeof toDraft]>['overlay'];
      // @ts-expect-error OrderedMapState.ops is internal
      export type OmapOps = DraftOrderedMap<string, number>[typeof DRAFT_STATE]['ops'];
      // What the protocol needs stays reachable.
      export type Still = [ReturnType<ValueList<number>[typeof toDraft]>['draft'], DraftOrderedMap<string, number>[typeof DRAFT_STATE]['kind']];
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  it("memoize keeps the function's own signature, and an unannotated callback is the implicit-any error", () => {
    const diagnostics = compileConsumer(
      declarations,
      `
      import { memoize } from '/published/index.js';
      declare function over(x: number): number;
      declare function over(x: string): string;
      const m = memoize(over);
      export const n: number = m(1);
      export const s: string = m('s');
      export const g = memoize(<T>(x: T): T => x);
      export const gs: string = g('s');
      m.clear();
      export const size: number = m.size;
      // @ts-expect-error an unannotated parameter is an implicit any: the error says to annotate
      export const u = memoize((todos, filter) => [todos, filter]);
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  // `stripInternal` keeps what is tagged `@internal` out of the declarations. A
  // tag on something they still need (a re-export, a helper type a public type
  // is spelled with) breaks every consumer's build and none of ours, so all
  // four entry points are compiled here, not only the one the suites above use.
  it('all four entry points compile without what was stripped', () => {
    const diagnostics = compileConsumer(
      declarations,
      `
      import * as valsem from '/published/index.js';
      import { registerTemporal } from '/published/temporal.js';
      import { defineRecordField, mutableBuiltinReason } from '/published/binding.js';
      import { DRAFT_STATE, stateOf, createDraftState, snapshotOf, type DraftState, type Scope } from '/published/draft.js';

      export const all = [valsem, registerTemporal, defineRecordField, mutableBuiltinReason, DRAFT_STATE, stateOf, createDraftState, snapshotOf];
      export type Kit = [DraftState, Scope, valsem.Draft<{ a: number[] }>, valsem.Undraft<unknown>];
      export const curried = valsem.produce((d: { n: number }) => void d.n++);
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  it('a value has no mutator: the imperative verbs do not compile on a value (D59)', () => {
    // An unused @ts-expect-error is itself a diagnostic, so each line below
    // fails the day a value grows a verb; draft-surface.test.ts checks the
    // same at runtime, over the prototypes.
    const diagnostics = compileConsumer(
      declarations,
      `
      import { ValueList, ValueMap, ValueSet, OrderedMap, OrderedSet } from '/published/index.js';
      const list = ValueList.of(1);
      // @ts-expect-error
      list.push(2);
      // @ts-expect-error
      list.pop();
      // @ts-expect-error
      list.shift();
      // @ts-expect-error
      list.unshift(0);
      // @ts-expect-error
      list.set(0, 2);
      // @ts-expect-error
      list.splice(0, 1);
      // @ts-expect-error
      list.insert(0, 2);
      // @ts-expect-error
      list.remove(0);
      // @ts-expect-error
      list.setMany([[0, 2]]);
      // @ts-expect-error
      list.toSpliced(0, undefined);
      const map = ValueMap.from([['a', 1]]);
      // @ts-expect-error
      map.set('b', 2);
      // @ts-expect-error
      map.delete('a');
      const set = ValueSet.of(1);
      // @ts-expect-error
      set.add(2);
      // @ts-expect-error
      set.delete(1);
      const oset = OrderedSet.of(1);
      // @ts-expect-error
      oset.add(2);
      // @ts-expect-error
      oset.delete(1);
      // @ts-expect-error
      oset.insertAt(0, 2);
      const omap = OrderedMap.from([['a', 1]]);
      // @ts-expect-error
      omap.set('b', 2);
      // @ts-expect-error
      omap.delete('a');
      // @ts-expect-error
      omap.insertAt(0, 'b', 2);
      // And the copying names compile, chained, since each returns the value.
      list.pushed(2).popped().with(0, 3).toSpliced(0, 1).inserted(0, 4).removed(0).shifted().unshifted(5);
      map.with('b', 2).deleted('a');
      set.added(2).deleted(1);
      oset.added(2).deleted(1).insertedAt(0, 3);
      omap.with('b', 2).deleted('a').insertedAt(0, 'c', 3);
      `,
    );
    expect(diagnostics).toEqual([]);
  });

  it('a consumer sees no internal member: the test hooks and the plumbing are gone', () => {
    // An unused @ts-expect-error is itself a diagnostic, so each line below
    // fails the day its member comes back.
    const diagnostics = compileConsumer(
      declarations,
      `
      import { ValueList, ValueMap, OrderedMap, OrderedSet } from '/published/index.js';
      // @ts-expect-error
      ValueList._record(() => 0);
      // @ts-expect-error
      ValueList.of(1)._structure();
      // @ts-expect-error
      ValueList.of(1)._spliceItems(0, 0, []);
      // @ts-expect-error
      ValueMap._nodeStats();
      // @ts-expect-error
      OrderedMap.empty()._anchorOf(1);
      // @ts-expect-error
      OrderedSet.empty()._anchorOf(1);
      `,
    );
    expect(diagnostics).toEqual([]);
    // What is left with a leading underscore is what public types and
    // valsem/binding are spelled with, and nothing else.
    const left = new Set<string>();
    for (const [file, text] of declarations) {
      if (file.endsWith('.d.ts')) for (const m of text.matchAll(/\b_[A-Za-z]\w*/g)) left.add(m[0]);
    }
    expect([...left].sort()).toEqual(['_CurriedFromRecipe', '_Frozen', '_HasFunctionMember', '_IsPlainArray', '_defineRecordField', '_mutableBuiltinReason']);
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
