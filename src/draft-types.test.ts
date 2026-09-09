// ---------------------------------------------------------------------------
// The types of produce, pinned. `pnpm typecheck` is the assertion: every
// `@ts-expect-error` below must be an error, and everything else must not.
// The runtime checks confirm the types describe what actually happens.
//
// The rules:
//   - Draft<T> drafts plain objects, arrays and [toDraft] implementers; an
//     opaque leaf — a class instance: ValueDate, InternedString, RawArray, a
//     user value type, a Temporal value — is handed out as ITSELF, methods
//     intact, fields readonly. Replace it by assigning into its slot.
//   - A recipe returns the state's type, its draft, void, or `nothing` (only
//     where the state type admits undefined) — immer's rule.
//   - The curried form types its extra arguments from the recipe.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, nothing, type Draft, type RecipeReturn } from './produce.js';
import { current, type Undraft } from './current.js';
import { intern } from './intern.js';
import { equals, hashCode } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { ValueDate } from './value-date.js';
import { ValueMap } from './value-map.js';
import { ValueList } from './value-list.js';
import { InternedString } from './interned-string.js';
import { RawArray } from './raw-array.js';
import { DraftMap } from './draft-map.js';
import { DraftList } from './draft-list.js';

class Money {
  readonly [hashCode]: number;
  constructor(readonly amount: number) {
    this[hashCode] = deepHash(amount);
  }
  [equals](o: unknown): boolean {
    return o instanceof Money && o.amount === this.amount;
  }
  plus(n: number): Money {
    return new Money(this.amount + n);
  }
}

/** Exact type equality. */
type Eq<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

// --- Draft<T> --------------------------------------------------------------

const leafIsItself: Eq<Draft<ValueDate>, ValueDate> = true;
const stringIsItself: Eq<Draft<InternedString>, InternedString> = true;
const rawIsItself: Eq<Draft<RawArray<number>>, RawArray<number>> = true;
const valueTypeIsItself: Eq<Draft<Money>, Money> = true;
const recordMaps: Eq<Draft<{ readonly a: number; readonly at: ValueDate }>, { a: number; at: ValueDate }> = true;
const arrayMaps: Eq<Draft<readonly { readonly x: number }[]>, { x: number }[]> = true;
// Tuples keep their shape (immer's plain-array rule), both ways.
const tupleMaps: Eq<Draft<{ readonly t: readonly [number, string] }>, { t: [number, string] }> = true;
const tupleBack: Eq<Undraft<Draft<{ t: readonly [number, ValueDate] }>>, { t: [number, ValueDate] }> = true;
const mapDrafts: Eq<Draft<ValueMap<string, number>>, DraftMap<string, number>> = true;
const listDrafts: Eq<Draft<ValueList<number>>, DraftList<number>> = true;
const primitives: Eq<Draft<string | null | undefined>, string | null | undefined> = true;
// An `any` member is not a method: the record still drafts, and stays writable.
const anyMemberStillDrafts: Eq<Draft<{ readonly count: number; readonly meta: any }>, { count: number; meta: any }> = true;
const unknownMemberStillDrafts: Eq<Draft<{ readonly count: number; readonly meta: unknown }>, { count: number; meta: unknown }> = true;
// A nullable or optional function member counts like a plain one: a leaf.
type Handler = { readonly id: number; readonly cb: (() => void) | null };
type OptHandler = { readonly id: number; readonly cb?: () => void };
const nullableFnIsLeaf: Eq<Draft<Handler>, Handler> = true;
const optionalFnIsLeaf: Eq<Draft<OptHandler>, OptHandler> = true;
// `never` members are not functions: the exclusive-union idiom still drafts.
type Xor = { readonly a: number; readonly b?: never } | { readonly b: string; readonly a?: never };
const xorDrafts: Eq<Draft<Xor>, { a: number; b?: never } | { b: string; a?: never }> = true;
const optUndefinedDrafts: Eq<Draft<{ readonly a: number; readonly b?: undefined }>, { a: number; b?: undefined }> = true;
const neverMemberDrafts: Eq<Draft<{ readonly kind: 'a'; readonly payload: never }>, { kind: 'a'; payload: never }> = true;

// --- Undraft<D> ------------------------------------------------------------

const undraftLeaf: Eq<Undraft<ValueDate>, ValueDate> = true;
const undraftRoundTrip: Eq<
  Undraft<Draft<{ m: ValueMap<string, number>; at: ValueDate; xs: number[] }>>,
  { m: ValueMap<string, number>; at: ValueDate; xs: number[] }
> = true;

// --- RecipeReturn<T> -------------------------------------------------------

const nothingOnlyWhenOptional: Eq<Extract<RecipeReturn<{ a: number }>, typeof nothing>, never> = true;
const nothingWhenOptional: Eq<Extract<RecipeReturn<{ a: number } | undefined>, typeof nothing>, typeof nothing> = true;

void [
  leafIsItself, stringIsItself, rawIsItself, valueTypeIsItself, recordMaps, arrayMaps,
  mapDrafts, listDrafts, primitives, tupleMaps, tupleBack, anyMemberStillDrafts, unknownMemberStillDrafts,
  nullableFnIsLeaf, optionalFnIsLeaf, xorDrafts, optUndefinedDrafts, neverMemberDrafts, undraftLeaf, undraftRoundTrip,
  nothingOnlyWhenOptional, nothingWhenOptional,
];

describe('produce — the types describe the runtime', () => {
  it('an opaque leaf is itself inside a recipe: methods work, fields are readonly, the slot is writable', () => {
    const base = intern({ at: ValueDate.of(0), name: InternedString.for('x'), price: new Money(1) });
    const next = produce(base, (d) => {
      expect(d.at).toBe(base.at); // the canonical value itself, not a proxy
      expect(d.at.toDate().getTime()).toBe(0);
      d.at = ValueDate.of(1000);
      d.name = InternedString.for(d.name.value + '!');
      d.price = d.price.plus(1);
      // @ts-expect-error — a readonly field of an opaque leaf
      expect(() => (d.at.epochMs = 5)).toThrow(TypeError); // and frozen at runtime
      // @ts-expect-error — a readonly field of an opaque leaf
      expect(() => (d.name.value = 'y')).toThrow(TypeError);
      // @ts-expect-error — a readonly field of a user value type
      void ((): void => void (d.price.amount = 2));
      const snap: { at: ValueDate; name: InternedString; price: Money } = current(d);
      expect(snap.at).toBe(ValueDate.of(1000));
    });
    expect(next).toBe(intern({ at: ValueDate.of(1000), name: InternedString.for('x!'), price: new Money(2) }));
  });

  it('a record with an any-typed field drafts and stays writable', () => {
    interface S { readonly count: number; readonly meta: any }
    const s: S = intern({ count: 1, meta: { free: 'form' } });
    const next = produce(s, (d) => {
      d.count++;
      d.meta = { free: 'still' };
    });
    expect(next).toBe(intern({ count: 2, meta: { free: 'still' } }));
  });

  it('a recipe returns the state type, its draft, or nothing where undefined is admitted', () => {
    expect(produce({ a: 1 }, () => ({ a: 2 }))).toBe(intern({ a: 2 }));
    expect(produce({ a: 1 }, (d) => d)).toBe(intern({ a: 1 }));
    expect(produce<{ a: number } | undefined>({ a: 1 }, () => nothing)).toBeUndefined();
    expect(produceWithPatches<{ a: number } | undefined>({ a: 1 }, () => nothing)[0]).toBeUndefined();
    // …and with the state type inferred, not spelled out (a function return,
    // so control flow cannot narrow the union away).
    const load = (): { a: number } | undefined => ({ a: 1 });
    expect(produce(load(), () => nothing)).toBeUndefined();
    expect(produce(load(), (d) => (d === undefined ? nothing : d))).toBe(intern({ a: 1 }));
    expect(produceWithPatches(load(), () => nothing)[0]).toBeUndefined();
    const clear = produce((d: Draft<{ a: number } | undefined>) => (d === undefined ? undefined : nothing));
    expect(clear(load())).toBeUndefined();
    // @ts-expect-error — a replacement of another shape
    produce({ a: 1 }, () => ({ b: 2 }));
    // @ts-expect-error — nothing on a state that cannot be undefined
    produce({ a: 1 }, () => nothing);
    // @ts-expect-error — an async recipe (rejected at runtime too)
    expect(() => produce({ a: 1 }, async () => {})).toThrow(/synchronous/);
  });

  it('the curried form types its extra arguments and infers the state from the draft annotation', () => {
    // State holding a collection and a readonly array: the draft shape differs
    // from the state shape, and the producer must take and return the STATE.
    interface Todo {
      readonly done: boolean;
      readonly tags: ValueMap<string, number>;
      readonly ids: readonly number[];
    }
    const todo: Todo = intern({ done: false, tags: ValueMap.fromObject({ a: 1 }), ids: [1] });
    const setDone = produce((d: Draft<Todo>, done: boolean) => {
      d.done = done;
      d.tags.set('b', 2);
      d.ids.push(2);
    });
    const r: Todo = setDone(todo, true);
    expect(r).toBe(intern({ done: true, tags: ValueMap.fromObject({ a: 1, b: 2 }), ids: [1, 2] }));
    expect(r.tags).toBeInstanceOf(ValueMap);
    // The explicit spellings (immer's) work for the same state.
    const toggle = produce<Todo>((d) => {
      d.done = !d.done;
      d.tags.set('b', 2);
      d.ids.push(2);
    });
    const r2: Todo = toggle(todo);
    expect(r2).toBe(r);
    const setDone2 = produce<Todo, [boolean]>((d, done) => {
      d.done = done;
      d.tags.set('b', 2);
      d.ids.push(2);
    });
    expect(setDone2(todo, true)).toBe(r);
    // Tuples round-trip through the curried form.
    type S3 = { readonly t: readonly [number, string] };
    const s3: S3 = intern({ t: [1, 'a'] as [number, string] });
    const bump = produce((d: Draft<S3>) => {
      d.t[0] = 2;
      // Type-only: not executed.
      // @ts-expect-error — a tuple slot keeps its type
      void (() => (d.t[0] = 'x'));
    });
    const r3: S3 = bump(s3);
    expect(r3).toBe(intern({ t: [2, 'a'] as [number, string] }));
    // A mutable-declared state is accepted too (the parameter is the frozen shape).
    const mutableTodo: { done: boolean; tags: ValueMap<string, number>; ids: number[] } = todo as never;
    expect(setDone(mutableTodo, true)).toBe(r);
    // Type-only: not executed (the base would lack `tags`).
    // @ts-expect-error — wrong argument type
    void (() => setDone({ done: false }, 'nope'));
    const inc = produce<{ n: number }>((d) => {
      d.n++;
    });
    expect(inc({ n: 1 })).toBe(intern({ n: 2 }));
    // @ts-expect-error — no extra arguments were declared
    inc({ n: 1 }, 2);
  });
});
