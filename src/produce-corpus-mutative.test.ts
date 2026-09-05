// Cases adapted from the mutative test suite (index.test.ts, create.test.ts,
// array.test.ts, edge cases) — the second corpus pass after immer's. Where
// valsem's canonical semantics deliberately diverge (set dedup, ===
// convergence on no-ops, async rejection), the divergence is asserted.
import { describe, expect, it } from 'vitest';
import { produce, produceWithPatches } from './produce.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';

describe('mutative corpus — #18: assigning a non-draft, then mutating it', () => {
  // In mutative/immer the assigned raw object is the caller's and mutations
  // hit it directly. In valsem an assigned CANONICAL is frozen — reads must
  // copy-on-write so the pattern works without corrupting (or throwing on)
  // the canonical.

  it('object key: assign a canonical sibling, mutate through the draft', () => {
    const base = intern({ a: { v: 1 }, b: { w: 2 } });
    const next = produce(base, (d) => {
      (d as Record<string, unknown>).c = base.b;
      (d as unknown as { c: { w: number } }).c.w = 9;
    });
    expect(next).toBe(intern({ a: { v: 1 }, b: { w: 2 }, c: { w: 9 } }));
    expect(base.b).toBe(intern({ w: 2 })); // canonical untouched
  });

  it('array slot: assign a canonical element elsewhere, mutate it', () => {
    const base = intern({ arr: [{ v: 1 }, { v: 2 }] });
    const next = produce(base, (d) => {
      d.arr[1] = base.arr[0]!;
      d.arr[1]!.v = 5;
    });
    expect(next).toBe(intern({ arr: [{ v: 1 }, { v: 5 }] }));
    expect(base.arr[0]).toBe(intern({ v: 1 }));
  });

  it('map value: set a canonical, mutate through get', () => {
    const base = intern({ m: ValueMap.fromObject<{ w: number }>({}), src: { w: 2 } });
    const next = produce(base, (d) => {
      d.m.set('k', base.src);
      d.m.get('k')!.w = 9;
    });
    expect(next.m).toBe(ValueMap.fromObject({ k: { w: 9 } }));
    expect(base.src).toBe(intern({ w: 2 }));
  });

  it('deep: assign a canonical subtree, mutate deep inside it', () => {
    const base = intern({ src: { mid: { leaf: 1 } }, dst: null as unknown });
    const next = produce(base, (d) => {
      d.dst = base.src;
      (d.dst as { mid: { leaf: number } }).mid.leaf = 7;
    });
    expect(next).toBe(
      intern({ src: { mid: { leaf: 1 } }, dst: { mid: { leaf: 7 } } }),
    );
  });

  it('assigning the original value back over its own draft nets out', () => {
    const base = intern({ a: { v: 1 } });
    const next = produce(base, (d) => {
      void d.a.v; // draft the child
      (d as { a: unknown }).a = base.a; // restore the original
    });
    expect(next).toBe(base);
  });
});

describe('mutative corpus — aliasing through draft refs', () => {
  it('assigning a draft ref aliases: mutation shows at both paths, one canonical instance', () => {
    const base = intern({ b: { w: 2 }, c: null as unknown });
    const next = produce(base, (d) => {
      d.c = d.b;
      d.b.w = 9;
    });
    expect(next).toBe(intern({ b: { w: 9 }, c: { w: 9 } }));
    expect(next.b).toBe(next.c); // hash-consing: literally the same object
  });

  it('push a draft ref, reverse, then mutate — still one identity', () => {
    const base = intern({ arr: [{ v: 1 }, { v: 2 }] });
    const next = produce(base, (d) => {
      d.arr.push(d.arr[0]!);
      d.arr.reverse();
      d.arr[0]!.v = 8; // the pushed ref, now relocated to index 0
    });
    expect(next).toBe(intern({ arr: [{ v: 8 }, { v: 2 }, { v: 8 }] }));
    expect(next.arr[0]).toBe(next.arr[2]);
  });
});

describe('mutative corpus — set semantics diverge: structural dedup', () => {
  it('adding a structurally-equal element is a no-op (mutative/immer would grow the set)', () => {
    const base = intern({ s: ValueSet.from([{ id: 1 }]) });
    expect(produce(base, (d) => void d.s.add({ id: 1 }))).toBe(base);
  });

  it('adding then deleting a structural twin round-trips to base', () => {
    const base = intern({ s: ValueSet.from([{ id: 1 }, { id: 2 }]) });
    const next = produce(base, (d) => {
      d.s.add({ id: 3 });
      d.s.delete({ id: 3 }); // a DIFFERENT raw object, structurally equal
    });
    expect(next).toBe(base);
  });
});

describe('mutative corpus — opaque array methods (copyWithin/fill)', () => {
  it('copyWithin then mutate a duplicated element', () => {
    const base = intern({ arr: [{ v: 1 }, { v: 2 }, { v: 3 }] });
    const next = produce(base, (d) => {
      d.arr.copyWithin(2, 0, 1); // [ {1}, {2}, {1} ]
      d.arr[2]!.v = 9;
    });
    expect(next).toBe(intern({ arr: [{ v: 1 }, { v: 2 }, { v: 9 }] }));
    expect(base.arr[0]).toBe(intern({ v: 1 })); // base untouched
  });

  it('fill with an object, then mutate one slot', () => {
    const base = intern({ arr: [1, 2, 3] });
    const next = produce(base, (d) => {
      (d.arr as unknown[]).fill({ x: 0 }, 1);
      (d.arr[1] as unknown as { x: number }).x = 5;
    });
    // fill writes ONE object into both slots; mutating through index 1
    // mutates that shared object — both slots reflect it (plain JS
    // aliasing), and canonically they are one instance.
    expect(next).toBe(intern({ arr: [1, { x: 5 }, { x: 5 }] }));
  });
});

describe('mutative corpus — convergence odds and ends', () => {
  it('setting NaN over NaN is no update', () => {
    const base = intern({ a: NaN, arr: [NaN] });
    expect(produce(base, (d) => void (d.a = NaN))).toBe(base);
    expect(produce(base, (d) => void (d.arr[0] = NaN))).toBe(base);
  });

  it('shift+unshift of the same values converges on base with no patches', () => {
    const base = intern({ l: [1, 2, 3] });
    const [result, patches, inverse] = produceWithPatches(base, (d) => {
      const x = d.l.shift();
      d.l.unshift(x as number);
    });
    expect(result).toBe(base);
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });
});

describe('mutative corpus — boundary rejections', () => {
  it('cyclic input is rejected (cycles are a permanent non-goal)', () => {
    const cyc: Record<string, unknown> = { x: 1 };
    cyc['self'] = cyc;
    expect(() => produce(intern({ a: 1 }), (d) => void ((d as Record<string, unknown>).c = cyc))).toThrow();
  });

  it('a leaked draft is revoked after produce returns', () => {
    let leaked: { y: number } | undefined;
    produce(intern({ x: { y: 1 } }), (d) => {
      leaked = d.x;
    });
    expect(() => leaked!.y).toThrow(/revoked/);
  });

  it('async recipes are rejected with a teaching error', () => {
    const base = intern({ a: 1 });
    expect(() => produce(base, (async () => {}) as unknown as (d: unknown) => void)).toThrow(
      /recipes must be synchronous/,
    );
    expect(() =>
      produce(base, (async (d: { a: number }) => {
        d.a = 2;
      }) as unknown as (d: unknown) => void),
    ).toThrow(/recipes must be synchronous/);
  });
});
