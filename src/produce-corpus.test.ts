// Cases adapted from the immer test suite (base.js, updateScenarios.js,
// regressions, null.js) — the behaviors a produce implementation earns the
// hard way. Where valsem's semantics deliberately diverge (canonical results,
// record undefined-dropping, symbol keys rejected), the divergence is
// asserted, not skipped.
import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, applyPatches, nothing } from './produce.js';
import { intern } from './intern.js';
import { ValueList } from './value-list.js';

describe('corpus — no-ops converge on the canonical base', () => {
  const base = intern({ a: 1, list: [1, 2, 3], nested: { x: 1 } });

  it('no-op producer', () => {
    expect(produce(base, () => {})).toBe(base);
  });

  it('read-only access, however deep (#659)', () => {
    expect(
      produce(base, (d) => {
        void d.a;
        void d.nested.x;
        void d.list[0];
        d.list.indexOf(2);
        void d.list.length;
        JSON.stringify(d);
      }),
    ).toBe(base);
  });

  it('no-op array methods (#push()/splice()/pop-on-empty…)', () => {
    expect(produce(base, (d) => void d.list.push())).toBe(base);
    expect(produce(base, (d) => void d.list.splice(1, 0))).toBe(base);
    expect(produce(intern({ l: [] as number[] }), (d) => void d.l.pop())).toBe(
      intern({ l: [] as number[] }),
    );
    expect(produce(intern({ l: [7] }), (d) => void d.l.sort())).toBe(intern({ l: [7] }));
  });

  it('setting a field to its current value', () => {
    expect(produce(base, (d) => void (d.a = 1))).toBe(base);
    expect(produce(base, (d) => void (d.list[0] = 1))).toBe(base);
  });

  it('deleting a non-existent key', () => {
    expect(
      produce(base, (d) => {
        delete (d as Record<string, unknown>).ghost;
      }),
    ).toBe(base);
  });

  it('#646 — setting an absent field to undefined creates no new result', () => {
    expect(produce(base, (d) => void ((d as Record<string, unknown>).ghost = undefined))).toBe(
      base,
    );
  });
});

describe('corpus — delete and re-add', () => {
  const base = intern({ a: 1, b: 2 });

  it('set a property to its original value after deleting it', () => {
    expect(
      produce(base, (d) => {
        delete (d as { a?: number }).a;
        d.a = 1;
      }),
    ).toBe(base);
  });

  it('delete a property added in the producer', () => {
    expect(
      produce(base, (d) => {
        (d as Record<string, unknown>).c = 3;
        delete (d as Record<string, unknown>).c;
      }),
    ).toBe(base);
  });

  it('delete then re-add with a different value', () => {
    expect(
      produce(base, (d) => {
        delete (d as { a?: number }).a;
        d.a = 9;
      }),
    ).toBe(intern({ a: 9, b: 2 }));
  });

  it('delete-then-readd of the same value emits no patches', () => {
    const [result, patches, inverse] = produceWithPatches(base, (d) => {
      delete (d as { a?: number }).a;
      d.a = 1;
    });
    expect(result).toBe(base);
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });
});

describe('corpus — array scenarios (updateScenarios.js)', () => {
  const mk = () =>
    intern({
      items: [
        { id: 1, done: false, v: 10 },
        { id: 2, done: true, v: 20 },
        { id: 3, done: false, v: 30 },
      ],
    });

  it('push then mutate the pushed item', () => {
    const next = produce(mk(), (d) => {
      d.items.push({ id: 4, done: false, v: 40 });
      d.items[3]!.v = 44;
    });
    expect(next.items[3]).toBe(intern({ id: 4, done: false, v: 44 }));
  });

  it('splice in, then mutate the spliced-in item', () => {
    const next = produce(mk(), (d) => {
      d.items.splice(1, 0, { id: 9, done: false, v: 0 });
      d.items[1]!.v = 99;
    });
    expect(next.items.length).toBe(4);
    expect(next.items[1]).toBe(intern({ id: 9, done: false, v: 99 }));
    expect(next.items[2]).toBe(mk().items[1]);
  });

  it('mutations through filter results are reflected', () => {
    const next = produce(mk(), (d) => {
      for (const item of d.items.filter((i) => !i.done)) item.v += 1;
    });
    expect(next).toBe(
      intern({
        items: [
          { id: 1, done: false, v: 11 },
          { id: 2, done: true, v: 20 },
          { id: 3, done: false, v: 31 },
        ],
      }),
    );
  });

  it('cross-reference: a filtered array of drafts assigned elsewhere converges', () => {
    const base = intern({ items: mk().items, selected: null as unknown });
    const next = produce(base, (d) => {
      const done = d.items.filter((i) => i.done);
      d.selected = done;
      done[0]!.v = 21; // mutate AFTER assigning the array containing the draft
    });
    const sel = next.selected as { id: number; v: number }[];
    expect(sel[0]).toBe(next.items[1]); // one canonical instance, both locations
    expect(sel[0]!.v).toBe(21);
  });

  it('length truncation and extension', () => {
    expect(produce(intern({ l: [1, 2, 3, 4] }), (d) => void (d.l.length = 2))).toBe(
      intern({ l: [1, 2] }),
    );
    const extended = produce(intern({ l: [1] }), (d) => void (d.l.length = 3));
    expect(extended.l.length).toBe(3);
    expect(extended.l[2]).toBeUndefined();
  });

  it('#638 — out-of-range assignment grows the array', () => {
    const next = produce(intern({ l: [1] }), (d) => void (d.l[3] = 9));
    expect(next.l.length).toBe(4);
    expect(next.l[3]).toBe(9);
    expect(next.l[2]).toBeUndefined();
  });

  it('pop then push, and multiple shifts', () => {
    expect(
      produce(intern({ l: [1, 2, 3] }), (d) => {
        d.l.pop();
        d.l.push(9);
      }),
    ).toBe(intern({ l: [1, 2, 9] }));
    expect(
      produce(intern({ l: [1, 2, 3] }), (d) => {
        d.l.shift();
        d.l.shift();
      }),
    ).toBe(intern({ l: [3] }));
  });
});

describe('corpus — relocation after sort/reverse (the baseRefs problem)', () => {
  it('mutating an element after sort() does not mutate a RAW base', () => {
    const raw = { arr: [{ v: 3 }, { v: 1 }, { v: 2 }] };
    const next = produce(raw, (d) => {
      d.arr.sort((a, b) => a.v - b.v);
      d.arr[0]!.v = 100; // relocated base element — must be drafted, not raw
    });
    expect(raw.arr.map((x) => x.v)).toEqual([3, 1, 2]); // base untouched
    expect(next).toBe(intern({ arr: [{ v: 100 }, { v: 2 }, { v: 3 }] }));
  });

  it('sorts correctly with existing child drafts in the array', () => {
    const base = intern({ arr: [{ v: 3 }, { v: 1 }, { v: 2 }] });
    const next = produce(base, (d) => {
      d.arr[1]!.v = 5; // draft created pre-sort
      d.arr.sort((a, b) => a.v - b.v);
    });
    expect(next).toBe(intern({ arr: [{ v: 2 }, { v: 3 }, { v: 5 }] }));
  });

  it('reverse then mutate', () => {
    const next = produce(intern({ arr: [{ v: 1 }, { v: 2 }] }), (d) => {
      d.arr.reverse();
      d.arr[1]!.v = 9;
    });
    expect(next).toBe(intern({ arr: [{ v: 2 }, { v: 9 }] }));
  });
});

describe('corpus — recipe return forms', () => {
  it('returning a nested draft replaces the result with its final value', () => {
    const base = intern({ keep: { x: 1 }, drop: true });
    expect(produce(base, (d) => d.keep)).toBe(intern({ x: 1 }));
  });

  it('returning a nested draft AFTER mutating throws (mutate xor return — immer parity)', () => {
    const base = intern({ keep: { x: 1 }, drop: true });
    expect(() =>
      produce(base, (d) => {
        d.keep.x = 2; // modification bubbles to the root draft …
        return d.keep; // … so returning a replacement is ambiguous: throw
      }),
    ).toThrow(/either mutate the draft or return/);
  });

  it('returning a new object that embeds a draft', () => {
    const base = intern({ inner: { n: 1 } });
    expect(produce(base, (d) => ({ wrapped: d.inner }))).toBe(
      intern({ wrapped: { n: 1 } }),
    );
  });

  it('null and undefined bases', () => {
    expect(produce(null, () => {})).toBeNull();
    expect(produce(undefined, () => {})).toBeUndefined();
    expect(produce(undefined, () => 42)).toBe(42);
    expect(produce({ a: 1 }, () => null)).toBeNull();
  });

  it('produceWithPatches with a nothing result round-trips', () => {
    const base = intern({ a: 1 });
    const [result, patches, inverse] = produceWithPatches(base, () => nothing);
    expect(result).toBeUndefined();
    expect(applyPatches(base, patches)).toBeUndefined();
    expect(applyPatches(undefined, inverse)).toBe(base);
  });
});

describe('corpus — curried form with arguments', () => {
  it('extra call arguments flow into the recipe', () => {
    const setValue = produce<{ v: number }>((d, next: number) => {
      d.v = next;
    });
    expect(setValue(intern({ v: 1 }), 5)).toBe(intern({ v: 5 }));
    expect(setValue(intern({ v: 1 }), 1)).toBe(intern({ v: 1 }));
  });
});

describe('corpus — property-suite finds (pinned)', () => {
  // Each of these was found by the fast-check convergence suite; pinned here
  // as deterministic regressions.

  it('mutating an element relocated by unshift does not touch a raw base', () => {
    // Tracked splices relocate surviving positions just like sort/reverse:
    // reading the moved element must draft it, not hand back the frozen base.
    const base = intern({ arr: [{ v: 1 }, { v: 2 }] });
    const next = produce(base, (d) => {
      d.arr.unshift({ v: 0 });
      d.arr[1]!.v = 99; // base's {v:1}, now at index 1
    });
    expect(next).toBe(intern({ arr: [{ v: 0 }, { v: 99 }, { v: 2 }] }));
    expect(base.arr[0]).toBe(intern({ v: 1 }));
    const shifted = produce(base, (d) => {
      d.arr.shift();
      d.arr[0]!.v = 7; // base's {v:2}, now at index 0
    });
    expect(shifted).toBe(intern({ arr: [{ v: 7 }] }));
  });

  it('netted-out sequence ops retract their patches', () => {
    // pop-then-push of the same value converges on the base — the op-derived
    // patches must be retracted, for arrays and lists alike.
    const arrBase = intern({ l: [1, 2, 3] });
    const [ar, ap, ai] = produceWithPatches(arrBase, (d) => {
      d.l.pop();
      d.l.push(3);
    });
    expect(ar).toBe(arrBase);
    expect(ap).toEqual([]);
    expect(ai).toEqual([]);

    const listBase = intern({ l: ValueList.of(1, 2, 3) });
    const [lr, lp, li] = produceWithPatches(listBase, (d) => {
      d.l.push(4);
      d.l.pop();
    });
    expect(lr).toBe(listBase);
    expect(lp).toEqual([]);
    expect(li).toEqual([]);
  });

  it('a read-but-unchanged child never leaks a draft into the result', () => {
    // With a materialized copy (splice) and an accumulator fast path, the
    // netted-out child draft written into the copy by the read trap must be
    // replaced by the base value, not interned into the successor.
    const base = intern({ arr: [{ a: 1 }, { b: 2 }, 3] });
    const next = produce(base, (d) => {
      void (d.arr[0] as { a?: number }).a; // read-only touch — drafts the child, changes nothing
      d.arr.push(4); // keeps ops mode, then force materialization:
      d.arr.splice(2, 1); // mid-copy state now holds the child draft
    });
    expect(next).toBe(intern({ arr: [{ a: 1 }, { b: 2 }, 4] }));
    expect(next.arr[0]).toBe(base.arr[0]); // the canonical child, not a proxy
    expect(() => JSON.stringify(next)).not.toThrow();
  });
});

describe('corpus — draft introspection', () => {
  it('property descriptors, the in operator, and Object.entries on drafts', () => {
    produce(intern({ a: 1, b: 2 }), (d) => {
      d.a = 10;
      expect('a' in d).toBe(true);
      expect('ghost' in d).toBe(false);
      const desc = Object.getOwnPropertyDescriptor(d, 'a');
      expect(desc?.value).toBe(10);
      expect(desc?.enumerable).toBe(true);
      expect(Object.entries(d).sort()).toEqual([
        ['a', 10],
        ['b', 2],
      ]);
      expect(JSON.parse(JSON.stringify(d))).toEqual({ a: 10, b: 2 });
    });
  });

  it('symbol keys on record drafts are rejected (records take string keys)', () => {
    const sym = Symbol('k');
    expect(() =>
      produce(intern({ a: 1 }), (d) => {
        (d as Record<symbol, unknown>)[sym] = 1;
      }),
    ).toThrow(/string keys/);
  });
});
