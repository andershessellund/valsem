// ---------------------------------------------------------------------------
// Two invariants at produce's boundary, each once violated silently:
//
// 1. A draft belongs to ONE recipe. A draft of another produce() call,
//    reachable from material given to this one — however deeply wrapped —
//    is rejected before it can be finalized. (Finalize is memoized: resolving
//    an enclosing recipe's draft early froze its result and dropped every
//    edit that recipe made afterwards.)
// 2. Nothing that is not a value comes out. A function has no content to
//    compare or hash, so every admission door rejects it — nested in data
//    the hasher always did; the front doors (`intern(fn)`, a recipe's
//    replacement, a non-draftable base) now do too.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, applyPatches, draft } from './produce.js';
import { current } from './current.js';
import { intern, isCanonical } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { OrderedMap } from './ordered-map.js';
import { OrderedSet } from './ordered-set.js';
import { memoize } from './memoize.js';

const FOREIGN = /a draft from a different produce\(\) call/;

describe('a draft of another recipe is rejected wherever it hides', () => {
  const base = intern({ child: { n: 0 }, list: ValueList.of({ n: 0 }) });
  type Child = { n: number };

  const wrappers: [string, (c: unknown) => unknown][] = [
    ['a record', (c) => ({ w: c })],
    ['an array', (c) => [c]],
    ['nested wrappers', (c) => ({ a: [{ b: [c] }] })],
  ];

  // Every way an inner recipe can take material in and hold it until finalize.
  const sinks: [string, (wrapped: unknown) => void][] = [
    ['record slot', (w) => produce(intern({ slot: null as unknown }), (d) => void (d.slot = w))],
    ['array push', (w) => produce(intern({ xs: [] as unknown[] }), (d) => void d.xs.push(w))],
    ['replacement', (w) => produce(intern({ a: 1 }) as unknown, () => w)],
    ['ValueMap value', (w) => produce(ValueMap.from<string, unknown>([['k', 1]]), (m) => void m.set('x', w))],
    ['ValueList push', (w) => produce(ValueList.of<unknown>(1), (l) => void l.push(w))],
    ['OrderedMap value', (w) => produce(OrderedMap.from<string, unknown>([['k', 1]]), (m) => void m.set('x', w))],
    ['detached draft', (w) => produce(intern({ slot: null as unknown }), (d) => {
      const free = draft(intern({ inner: null as unknown }));
      free.inner = w;
      d.slot = free;
    })],
  ];

  for (const [wName, wrap] of wrappers) {
    for (const [sName, sink] of sinks) {
      it(`${wName} → ${sName}: throws, and the outer recipe keeps its later edits`, () => {
        const result = produce(base, (outer) => {
          const c = outer.child;
          expect(() => sink(wrap(c))).toThrow(FOREIGN);
          c.n = 1; // the edit that used to be silently lost
        });
        expect(result.child.n).toBe(1);
        expect(result).not.toBe(base);
      });
    }
  }

  // Set members have no location: `add` takes the VALUE its argument has at
  // that moment (it interns on entry), for a draft of any recipe. Nothing is
  // finalized, so nothing can be lost — the member is simply a snapshot.
  for (const [wName, wrap] of wrappers) {
    it(`${wName} → a set member: a snapshot at add(), and the outer recipe keeps its later edits`, () => {
      let members: unknown[] = [];
      let ordered: unknown[] = [];
      const result = produce(base, (outer) => {
        const c = outer.child;
        members = [...produce(ValueSet.from<unknown>([]), (s) => void s.add(wrap(c)))];
        ordered = [...produce(OrderedSet.from<unknown>([]), (s) => void s.add(wrap(c)))];
        c.n = 1;
      });
      expect(result.child.n).toBe(1);
      expect(members).toEqual([intern(wrap({ n: 0 }))]);
      expect(ordered).toEqual([intern(wrap({ n: 0 }))]);
      expect(members[0]).toBe(intern(wrap({ n: 0 })));
    });
  }

  it('collection drafts and detached drafts of the outer recipe are caught too', () => {
    const result = produce(base, (outer) => {
      const l = outer.list;
      const free = draft(intern<Child>({ n: 5 }));
      expect(() => produce(intern({ s: null as unknown }), (d) => void (d.s = { w: l }))).toThrow(FOREIGN);
      expect(() => produce(intern({ s: null as unknown }), (d) => void (d.s = [free]))).toThrow(FOREIGN);
      l.push({ n: 2 });
      free.n = 6;
      outer.child = free;
    });
    expect(result.list.length).toBe(2);
    expect(result.child.n).toBe(6);
  });

  it('an escaped inner collection draft wrapped into the outer recipe is rejected', () => {
    expect(() =>
      produce(base, (outer) => {
        let leaked: unknown;
        produce(ValueList.of(1), (l) => void (leaked = l));
        (outer as unknown as { x: unknown }).x = { w: leaked };
      }),
    ).toThrow(FOREIGN);
  });

  it('with patches: same rejection, same outer result', () => {
    const [result, patches] = produceWithPatches(base, (outer) => {
      const c = outer.child;
      expect(() => produceWithPatches(intern({ s: null as unknown }), (d) => void (d.s = { w: c }))).toThrow(FOREIGN);
      c.n = 1;
    });
    expect(result.child.n).toBe(1);
    expect(applyPatches(base, patches)).toBe(result);
  });

  it('current() refuses the same material produce would, and still reads an outer draft on its own', () => {
    produce(base, (outer) => {
      const c = outer.child;
      c.n = 3;
      produce(intern({ s: null as unknown, t: 0 }), (d) => {
        expect(current(c)).toBe(intern({ n: 3 })); // an outer draft, read directly: fine
        d.t = 1;
        d.s = { w: c };
        expect(() => current(d)).toThrow(FOREIGN);
        d.s = { w: current(c) }; // the way to hand a draft's value across
      });
      c.n = 4;
    });
  });

  it('the documented route works: current(draft) crosses recipes', () => {
    const result = produce(base, (outer) => {
      const c = outer.child;
      c.n = 1;
      const inner = produce(intern({ s: null as unknown }), (d) => void (d.s = { w: current(c) }));
      expect(inner.s).toBe(intern({ w: { n: 1 } }));
      c.n = 2;
    });
    expect(result.child.n).toBe(2);
  });

  it('drafts of the SAME recipe inside wrappers still resolve', () => {
    const result = produce(base, (d) => {
      const c = d.child;
      (d as unknown as { x: unknown }).x = { a: [{ b: c }] };
      c.n = 9;
    });
    expect((result as unknown as { x: { a: { b: Child }[] } }).x.a[0]!.b).toBe(result.child);
    expect(result.child.n).toBe(9);
  });
});

describe('a function is not a value at any admission door', () => {
  const fn = (): number => 1;
  const NOT_A_VALUE = /a function is not a value/;
  const REJECTED = /a function is not a value|function is not supported/;

  it('intern(fn) throws', () => {
    expect(() => intern(fn)).toThrow(NOT_A_VALUE);
    expect(() => intern(class {})).toThrow(NOT_A_VALUE);
    expect(isCanonical(fn)).toBe(false);
  });

  it('a recipe cannot return one, and a function is not a base', () => {
    expect(() => produce({ x: 1 } as unknown, () => fn)).toThrow(NOT_A_VALUE);
    expect(() => produce(fn as unknown, () => {})).toThrow(NOT_A_VALUE);
    expect(() => produce(fn as unknown, () => 1)).not.toThrow(); // replaced before it is admitted
    expect(() => produceWithPatches({ x: 1 } as unknown, () => fn)).toThrow(NOT_A_VALUE);
  });

  it('nested in containers, collections and drafts', () => {
    expect(() => intern({ f: fn })).toThrow(REJECTED);
    expect(() => intern([fn])).toThrow(REJECTED);
    expect(() => ValueList.of<unknown>(fn)).toThrow(REJECTED);
    expect(() => ValueSet.from<unknown>([fn])).toThrow(REJECTED);
    expect(() => ValueMap.from<string, unknown>([['k', fn]])).toThrow(REJECTED);
    expect(() => ValueMap.from<unknown, number>([[fn, 1]])).toThrow(REJECTED);
    expect(() => produce({ x: 1 as unknown }, (d) => void (d.x = fn))).toThrow(REJECTED);
    expect(() => produce({ x: [] as unknown[] }, (d) => void d.x.push(fn))).toThrow(REJECTED);
    expect(() => produce({ x: 1 as unknown }, (d) => void (d.x = { deep: [fn] }))).toThrow(REJECTED);
    expect(() => produce(ValueMap.from<string, unknown>([['k', 1]]), (m) => void m.set('k', fn))).toThrow(REJECTED);
    expect(() => produce(ValueList.of<unknown>(1), (l) => void l.push(fn))).toThrow(REJECTED);
  });

  it('in a patch value', () => {
    expect(() => applyPatches(intern({ x: 1 }), [{ kind: 'record.set', path: [], key: 'x', value: fn }])).toThrow(REJECTED);
    expect(() => applyPatches(intern({ x: 1 }), [{ kind: 'replace', path: [], value: fn }])).toThrow(REJECTED);
  });

  it('memoize keeps its own wording for a function result', () => {
    const m = memoize((n: number) => () => n);
    expect(() => m(1)).toThrow(/returned a function, which is not a value/);
  });
});
