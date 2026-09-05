// produce — drafts in, canonical values out.
import { describe, it, expect } from 'vitest';
import {
  produce,
  produceWithPatches,
  applyPatches,
  nothing,
  isDraft,
  type Patch,
} from './produce.js';
import { DraftMap } from './draft-map.js';
import { DraftSet } from './draft-set.js';
import { DraftList } from './draft-list.js';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';

describe('produce — the degenerate law', () => {
  it('produce(base, noop) === intern(base)', () => {
    const canonical = intern({ a: 1, b: [1, 2] });
    expect(produce(canonical, () => {})).toBe(canonical);
    // Raw bases canonicalize too — intern is the degenerate case of produce.
    expect(produce({ a: 1, b: [1, 2] }, () => {})).toBe(canonical);
    expect(produce(42, () => {})).toBe(42);
  });

  it('edits that net out structurally converge on the canonical base', () => {
    const base = intern({ x: 1, y: 2 });
    const result = produce(base, (d) => {
      d.x = 99;
      d.x = 1;
    });
    expect(result).toBe(base);
  });
});

describe('produce — plain objects and arrays', () => {
  it('mutates a draft, returns the canonical successor, leaves base alone', () => {
    const base = intern({ count: 1, tag: 'a' });
    const next = produce(base, (d) => {
      d.count++;
    });
    expect(next).toBe(intern({ count: 2, tag: 'a' }));
    expect(base).toBe(intern({ count: 1, tag: 'a' }));
  });

  it('drafts nested objects lazily and shares untouched siblings', () => {
    const base = intern({ a: { x: 1 }, b: { y: 2 } });
    const next = produce(base, (d) => {
      d.a.x = 10;
    });
    expect(next).toBe(intern({ a: { x: 10 }, b: { y: 2 } }));
    expect(next.b).toBe(base.b); // untouched subtree shared (canonical)
  });

  it('supports delete, new keys, and undefined-means-delete', () => {
    const base = intern({ a: 1, b: 2 }) as Record<string, number | undefined>;
    expect(
      produce(base, (d) => {
        delete d.a;
        d.c = 3;
      }),
    ).toBe(intern({ b: 2, c: 3 }));
    expect(
      produce(base, (d) => {
        d.a = undefined; // record semantics: absent
      }),
    ).toBe(intern({ b: 2 }));
  });

  it('array push/splice/index writes produce canonical arrays', () => {
    const base = intern([1, 2, 3]) as number[];
    expect(produce(base, (d) => void d.push(4))).toBe(intern([1, 2, 3, 4]));
    expect(produce(base, (d) => void d.splice(1, 1, 9, 9))).toBe(intern([1, 9, 9, 3]));
    expect(
      produce(base, (d) => {
        d[0] = 7;
      }),
    ).toBe(intern([7, 2, 3]));
    expect(produce(base, (d) => void d.sort((a, b) => b - a))).toBe(intern([3, 2, 1]));
  });

  it('virtual array drafts read, iterate, and search without materializing', () => {
    const base = intern([1, 2, 3]) as number[];
    const next = produce(base, (d) => {
      d[1] = 9;
      d.push(5);
      expect(d.length).toBe(4);
      expect(d[1]).toBe(9);
      expect(d[3]).toBe(5);
      expect([...d]).toEqual([1, 9, 3, 5]); // iterator through virtual reads
      expect(d.indexOf(9)).toBe(1);
      expect(d.includes(5)).toBe(true);
      const seen: number[] = [];
      d.forEach((v) => seen.push(v));
      expect(seen).toEqual([1, 9, 3, 5]);
      expect(2 in d).toBe(true);
      expect(9 in d).toBe(false);
    });
    expect(next).toBe(intern([1, 9, 3, 5]));
  });

  it('ownKeys-style reads materialize and stay correct', () => {
    const base = intern([1, 2]) as number[];
    const next = produce(base, (d) => {
      d.push(3);
      expect(Object.keys(d)).toEqual(['0', '1', '2']);
      d[0] = 7; // mutate after materialization
    });
    expect(next).toBe(intern([7, 2, 3]));
  });

  it('mixes child drafts with virtual tail ops', () => {
    const base = intern({ arr: [{ n: 1 }, { n: 2 }] }) as { arr: { n: number }[] };
    const next = produce(base, (d) => {
      d.arr[0]!.n = 10;
      d.arr.push({ n: 3 });
      d.arr.pop();
      d.arr.push({ n: 4 });
    });
    expect(next).toBe(intern({ arr: [{ n: 10 }, { n: 2 }, { n: 4 }] }));
    expect(next.arr[1]).toBe(base.arr[1]);
  });

  it('repeated identical produces return the identical instance', () => {
    const base = intern({ arr: Array.from({ length: 100 }, (_, i) => ({ id: i, v: 0 })) });
    const results = new Set<unknown>();
    for (let i = 0; i < 20; i++) {
      results.add(
        produce(base, (d) => {
          d.arr[50]!.v = i % 3;
        }),
      );
    }
    expect(results.size).toBe(3); // one canonical instance per distinct state
  });

  it('drafts objects inside arrays', () => {
    const base = intern([{ n: 1 }, { n: 2 }]) as { n: number }[];
    const next = produce(base, (d) => {
      d[1]!.n = 20;
    });
    expect(next).toBe(intern([{ n: 1 }, { n: 20 }]));
    expect(next[0]).toBe(base[0]);
  });
});

describe('produce — value collections', () => {
  it('drafts a ValueMap slot as a DraftMap', () => {
    const base = intern({ users: ValueMap.fromObject({ anders: 1 }) }) as {
      users: ValueMap<string, number>;
    };
    const next = produce(base, (d) => {
      expect(d.users).toBeInstanceOf(DraftMap);
      d.users.set('freja', 2);
      expect(d.users.get('anders')).toBe(1);
      expect(d.users.size).toBe(2);
    });
    expect(next.users).toBe(ValueMap.fromObject({ anders: 1, freja: 2 }));
  });

  it('produces on a root ValueMap / ValueSet / ValueList', () => {
    const m = produce(ValueMap.fromObject({ a: 1 }), (d) => {
      d.set('b', 2);
      d.delete('a');
    });
    expect(m).toBe(ValueMap.fromObject({ b: 2 }));

    const s = produce(ValueSet.from([1, 2]), (d) => {
      expect(d).toBeInstanceOf(DraftSet);
      d.add(3);
      d.delete(1);
    });
    expect(s).toBe(ValueSet.from([2, 3]));

    const l = produce(ValueList.of(1, 2, 3), (d) => {
      expect(d).toBeInstanceOf(DraftList);
      d.splice(1, 1);
      d.push(9);
    });
    expect(l).toBe(ValueList.of(1, 3, 9));
  });

  it('drafts values inside a DraftMap', () => {
    const base = ValueMap.fromObject({ cfg: { depth: 1 } }) as ValueMap<
      string,
      { depth: number }
    >;
    const next = produce(base, (d) => {
      d.get('cfg')!.depth = 2;
    });
    expect(next).toBe(ValueMap.fromObject({ cfg: { depth: 2 } }));
  });

  it('unchanged collection ops return the same canonical instance', () => {
    const base = ValueMap.fromObject({ a: 1 });
    expect(produce(base, (d) => void d.set('a', 1))).toBe(base);
    const list = ValueList.of(1, 2);
    expect(produce(list, (d) => void d.set(0, 1))).toBe(list);
  });
});

describe('produce — grafts and aliasing', () => {
  it('adopts foreign raw material (interned on the way in)', () => {
    const base = intern({ a: 1 }) as Record<string, unknown>;
    const next = produce(base, (d) => {
      d.user = { name: 'X', tags: ['a'] };
    });
    expect(next).toBe(intern({ a: 1, user: { name: 'X', tags: ['a'] } }));
  });

  it('adopts foreign material containing embedded drafts', () => {
    const base = intern({ inner: { n: 1 }, other: 0 }) as {
      inner: { n: number };
      wrapper?: unknown;
      other: number;
    };
    const next = produce(base, (d) => {
      d.inner.n = 2;
      d.wrapper = { keep: d.inner }; // raw object embedding a draft
    });
    expect(next).toBe(
      intern({ inner: { n: 2 }, wrapper: { keep: { n: 2 } }, other: 0 }),
    );
    expect((next.wrapper as { keep: object }).keep).toBe(next.inner); // one canonical
  });

  it('aliased drafts converge on one canonical instance', () => {
    const base = intern({ a: { n: 1 }, b: null }) as { a: { n: number }; b: unknown };
    const next = produce(base, (d) => {
      d.b = d.a;
      d.a.n = 5;
    });
    expect(next.a).toBe(next.b);
    expect(next).toBe(intern({ a: { n: 5 }, b: { n: 5 } }));
  });
});

describe('produce — recipe conventions', () => {
  it('returned values replace the result; nothing means undefined', () => {
    expect(produce({ a: 1 }, () => ({ b: 2 }))).toBe(intern({ b: 2 }));
    expect(produce({ a: 1 }, () => nothing)).toBeUndefined();
  });

  it('mutating AND returning a replacement throws', () => {
    expect(() =>
      produce({ a: 1 }, (d) => {
        d.a = 2;
        return { b: 3 };
      }),
    ).toThrow(/either mutate the draft or return/);
  });

  it('drafts are revoked after produce', () => {
    let leaked: { a: number };
    produce({ a: 1 }, (d) => {
      leaked = d;
    });
    expect(() => leaked!.a).toThrow(/escaped|revoked/);

    let leakedMap: DraftMap<string, number>;
    produce(ValueMap.fromObject({ a: 1 }), (d) => {
      leakedMap = d;
    });
    expect(() => leakedMap!.get('a')).toThrow(/escaped/);
  });

  it('supports the curried form', () => {
    const inc = produce<{ n: number }>((d) => {
      d.n++;
    });
    expect(inc({ n: 1 })).toBe(intern({ n: 2 }));
    expect(inc(intern({ n: 5 }))).toBe(intern({ n: 6 }));
  });

  it('rejects drafts from a different produce call', () => {
    produce({ a: { x: 1 } }, (outer) => {
      expect(() =>
        produce({ b: 1 } as Record<string, unknown>, (inner) => {
          inner.stolen = outer.a;
        }),
      ).toThrow(/different produce/);
    });
  });

  it('isDraft distinguishes drafts from values', () => {
    produce({ a: { b: 1 } }, (d) => {
      expect(isDraft(d)).toBe(true);
      expect(isDraft(d.a)).toBe(true);
      expect(isDraft({ b: 1 })).toBe(false);
    });
  });
});

describe('produceWithPatches — semantic patches, both directions', () => {
  function roundtrip<T>(base: T, recipe: (d: never) => unknown): void {
    const canonicalBase = intern(base as unknown);
    const [result, patches, inverse] = produceWithPatches(
      canonicalBase as T,
      recipe as never,
    );
    // Forward: patches turn base into the result — canonically identical.
    expect(applyPatches(canonicalBase, patches)).toBe(result);
    // Backward: inverse patches restore the canonical base.
    expect(applyPatches(result, inverse)).toBe(canonicalBase);
  }

  it('record set/delete patches round-trip', () => {
    roundtrip({ a: 1, b: 2 }, (d: { a: number; b?: number; c?: number }) => {
      d.a = 10;
      delete d.b;
      d.c = 3;
    });
  });

  it('nested child patches carry paths', () => {
    const [, patches] = produceWithPatches(intern({ a: { deep: { n: 1 } } }), (d) => {
      d.a.deep.n = 2;
    });
    expect(patches).toEqual([
      { kind: 'record.set', path: ['a', 'deep'], key: 'n', value: 2 },
    ]);
    roundtrip({ a: { deep: { n: 1 } } }, (d: { a: { deep: { n: number } } }) => {
      d.a.deep.n = 2;
    });
  });

  it('list splices are recorded as intent, not diffed', () => {
    const [, patches] = produceWithPatches(ValueList.of(1, 2, 3, 4), (d) => {
      d.splice(1, 2, 9);
      d.push(5);
    });
    expect(patches).toEqual([
      { kind: 'list.splice', path: [], index: 1, remove: 2, insert: [9] },
      { kind: 'list.splice', path: [], index: 3, remove: 0, insert: [5] },
    ]);
    roundtrip(ValueList.of(1, 2, 3, 4), (d: DraftList<number>) => {
      d.splice(1, 2, 9);
      d.push(5);
    });
  });

  it('plain-array method interception records splices too', () => {
    const [, patches] = produceWithPatches(intern([1, 2, 3]) as number[], (d) => {
      d.shift();
      d.push(4);
    });
    expect(patches).toEqual([
      { kind: 'list.splice', path: [], index: 0, remove: 1, insert: [] },
      { kind: 'list.splice', path: [], index: 2, remove: 0, insert: [4] },
    ]);
    roundtrip([1, 2, 3], (d: number[]) => {
      d.shift();
      d.push(4);
    });
  });

  it('opaque array mutations fall back to a net diff that still round-trips', () => {
    roundtrip([3, 1, 2], (d: number[]) => {
      d.sort();
    });
    roundtrip([1, 2, 3, 4, 5], (d: number[]) => {
      d.reverse();
      d.length = 3;
    });
  });

  it('map and set patches round-trip, including clear', () => {
    roundtrip(ValueMap.fromObject({ a: 1, b: 2 }), (d: DraftMap<string, number>) => {
      d.set('a', 10);
      d.delete('b');
      d.set('c', 3);
    });
    roundtrip(ValueSet.from([1, 2, 3]), (d: DraftSet<number>) => {
      d.delete(2);
      d.add(9);
    });
    roundtrip(ValueMap.fromObject({ a: 1, b: 2 }), (d: DraftMap<string, number>) => {
      d.clear();
      d.set('z', 26);
    });
  });

  it('patches through a map path use the canonical key as segment', () => {
    const base = ValueMap.fromObject({ cfg: { n: 1 } }) as ValueMap<string, { n: number }>;
    const [result, patches] = produceWithPatches(base, (d) => {
      d.get('cfg')!.n = 2;
    });
    expect(patches).toEqual([{ kind: 'record.set', path: ['cfg'], key: 'n', value: 2 }]);
    expect(applyPatches(base, patches)).toBe(result);
  });

  it('replacement results emit a replace patch pair', () => {
    const base = intern({ a: 1 });
    const [result, patches, inverse] = produceWithPatches(base, () => ({ b: 2 }));
    expect(patches).toEqual([{ kind: 'replace', path: [], value: intern({ b: 2 }) }]);
    expect(applyPatches(base, patches)).toBe(result);
    expect(applyPatches(result, inverse)).toBe(base);
  });

  it('applyPatches applies strictly in order — a replace does not jump the queue', () => {
    const base = intern({ a: 1 });
    const patches: Patch[] = [
      { kind: 'record.set', path: [], key: 'b', value: 2 },
      { kind: 'replace', path: [], value: { z: 9 } },
    ];
    expect(applyPatches(base, patches)).toBe(intern({ z: 9 }));

    // …and edits AFTER a replace land on the replacement.
    const patches2: Patch[] = [
      { kind: 'record.set', path: [], key: 'b', value: 2 },
      { kind: 'replace', path: [], value: { z: 9 } },
      { kind: 'record.set', path: [], key: 'w', value: 3 },
    ];
    expect(applyPatches(base, patches2)).toBe(intern({ z: 9, w: 3 }));

    // A replace, then a run, then another replace: the middle run is discarded
    // by the second replace, exactly as sequential application would.
    const patches3: Patch[] = [
      { kind: 'replace', path: [], value: { z: 9 } },
      { kind: 'record.set', path: [], key: 'w', value: 3 },
      { kind: 'replace', path: [], value: { q: 0 } },
    ];
    expect(applyPatches(base, patches3)).toBe(intern({ q: 0 }));
    expect(() => applyPatches(base, [{ kind: 'replace', path: ['x'], value: 1 }])).toThrow(/root/);
  });

  it('no-change recipes emit no patches', () => {
    const [result, patches, inverse] = produceWithPatches(intern({ a: 1 }), () => {});
    expect(result).toBe(intern({ a: 1 }));
    expect(patches).toEqual([]);
    expect(inverse).toEqual([]);
  });
});
