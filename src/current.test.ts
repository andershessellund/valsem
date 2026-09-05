import { describe, it, expect, expectTypeOf } from 'vitest';
import { produce, produceWithPatches, type Draft } from './produce.js';
import { current, original, type Undraft } from './current.js';
import { intern } from './intern.js';
import { isDraft, snapshotOf } from './draft.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import type { DraftMap } from './draft-map.js';
import type { DraftList } from './draft-list.js';

const base = intern({
  title: 'x',
  tags: ['a', 'b'],
  meta: { views: 1, nested: { deep: true } },
  items: ValueList.of(1, 2, 3),
  index: ValueMap.from([['k', { n: 1 }]]),
  flags: ValueSet.from(['f']),
});

describe('original()', () => {
  it('is the base the draft was made from, at any depth and for every draft kind', () => {
    produce(base, (d) => {
      expect(original(d)).toBe(base);
      expect(original(d.meta)).toBe(base.meta);
      expect(original(d.tags)).toBe(base.tags);
      expect(original(d.items)).toBe(base.items);
      expect(original(d.index)).toBe(base.index);
      expect(original(d.flags)).toBe(base.flags);
      d.meta.views = 99;
      d.tags.push('c');
      expect(original(d.meta)).toBe(base.meta); // edits do not move it
      expect(original(d.tags)).toBe(base.tags);
    });
  });

  it('rejects non-drafts', () => {
    expect(() => original(base)).toThrow(/original\(\) expects a draft, got an object/);
    expect(() => original([1])).toThrow(/got a plain array/);
    expect(() => original(null)).toThrow(/got null/);
    expect(() => original(3)).toThrow(/got a number/);
  });
});

describe('current()', () => {
  it('on an untouched draft is the (canonical) base', () => {
    produce(base, (d) => {
      expect(current(d)).toBe(base);
      expect(current(d.meta)).toBe(base.meta);
      expect(current(d.items)).toBe(base.items);
    });
  });

  it('is the canonical value the recipe would produce if it stopped here', () => {
    let mid: typeof base | undefined;
    const next = produce(base, (d) => {
      d.title = 'y';
      d.meta.nested.deep = false;
      d.tags.push('c');
      mid = current(d);
      d.title = 'z'; // keep going after the snapshot
    });
    const expectedMid = produce(base, (d) => {
      d.title = 'y';
      d.meta.nested.deep = false;
      d.tags.push('c');
    });
    expect(mid).toBe(expectedMid); // canonical: pointer-equal to the independently produced value
    expect(isDraft(mid)).toBe(false);
    expect(Object.isFrozen(mid)).toBe(true);
    expect(next.title).toBe('z');
    expect(next.tags).toBe(expectedMid.tags); // unchanged subtrees are shared
  });

  it('leaves the draft live: child drafts held before the snapshot keep flowing into the result', () => {
    const next = produce(base, (d) => {
      const meta = d.meta;
      meta.views = 2;
      expect(current(d).meta).toBe(intern({ views: 2, nested: { deep: true } }));
      meta.views = 3; // the same child draft, after current()
      expect(d.meta.views).toBe(3);
    });
    expect(next.meta.views).toBe(3);
  });

  it('works on a nested draft directly', () => {
    produce(base, (d) => {
      d.meta.views = 5;
      expect(current(d.meta)).toBe(intern({ views: 5, nested: { deep: true } }));
      expect(current(d.meta.nested)).toBe(base.meta.nested);
    });
  });

  it('does not emit patches or disturb the ones the recipe produces', () => {
    const [next, patches] = produceWithPatches(base, (d) => {
      d.title = 'y';
      current(d);
      d.meta.views = 7;
      current(d.meta);
    });
    const [same, samePatches] = produceWithPatches(base, (d) => {
      d.title = 'y';
      d.meta.views = 7;
    });
    expect(patches).toEqual(samePatches);
    expect(patches).toHaveLength(2);
    expect(next).toBe(same);
  });

  it('arrays: virtual edits (set + push) and materialized ones (splice, sort)', () => {
    const b = intern({ arr: [3, 1, 2] });
    produce(b, (d) => {
      d.arr[0] = 30;
      d.arr.push(4);
      expect(current(d.arr)).toBe(intern([30, 1, 2, 4]));
      d.arr.splice(1, 1);
      expect(current(d.arr)).toBe(intern([30, 2, 4]));
      d.arr.sort((x, y) => x - y);
      expect(current(d)).toBe(intern({ arr: [2, 4, 30] }));
    });
  });

  it('collections: DraftMap, DraftSet and DraftList, with nested drafts inside', () => {
    produce(base, (d) => {
      d.index.set('k2', { n: 2 });
      d.index.get('k')!.n = 10;
      expect(current(d.index)).toBe(
        ValueMap.from<string, { n: number }>([
          ['k', { n: 10 }],
          ['k2', { n: 2 }],
        ]),
      );
      d.index.delete('k');
      expect(current(d.index)).toBe(ValueMap.from([['k2', { n: 2 }]]));
      d.index.clear();
      expect(current(d.index)).toBe(ValueMap.empty());

      d.flags.add('g');
      d.flags.delete('f');
      expect(current(d.flags)).toBe(ValueSet.from(['g']));

      d.items.set(0, 100);
      d.items.push(4);
      expect(current(d.items)).toBe(ValueList.of(100, 2, 3, 4));
      d.items.splice(1, 2);
      expect(current(d.items)).toBe(ValueList.of(100, 4));
    });
  });

  it('a raw object assigned into the draft that embeds a draft is snapshotted through', () => {
    produce(base, (d) => {
      d.meta.views = 8;
      (d as unknown as Record<string, unknown>).wrapped = { inner: d.meta, list: [d.tags] };
      expect(current(d)).toBe(
        intern({ ...base, meta: { views: 8, nested: { deep: true } }, wrapped: { inner: { views: 8, nested: { deep: true } }, list: [['a', 'b']] } }),
      );
    });
  });

  it('a snapshot can go straight back into the draft (it is canonical, so adoption is O(1))', () => {
    const doc = intern({ text: 'a', history: [] as { text: string }[] });
    const next = produce(doc, (d) => {
      d.text = 'ab';
      d.history.push(current(d).text === 'ab' ? { text: current(d).text } : { text: '?' });
      d.text = 'abc';
    });
    expect(next).toBe(intern({ text: 'abc', history: [{ text: 'ab' }] }));
  });

  it('after the recipe, both throw the escaped-draft error', () => {
    let leaked: Draft<typeof base> | undefined;
    produce(base, (d) => void (leaked = d));
    expect(() => current(leaked!)).toThrow(/escaped its produce\(\) call/);
    expect(() => original(leaked!)).toThrow(/escaped its produce\(\) call/);
  });

  it('rejects non-drafts', () => {
    expect(() => current(base)).toThrow(/current\(\) expects a draft/);
  });

  it('snapshotOf on a non-draft returns it unchanged', () => {
    expect(snapshotOf(base)).toBe(base);
    expect(snapshotOf(3)).toBe(3);
    const raw = { a: 1 };
    expect(snapshotOf(raw)).toBe(raw);
  });

  it('Undraft<T> inverts Draft<T>', () => {
    expectTypeOf<Undraft<Draft<typeof base>>>().toEqualTypeOf<typeof base>();
    expectTypeOf<Undraft<DraftMap<string, number>>>().toEqualTypeOf<ValueMap<string, number>>();
    expectTypeOf<Undraft<DraftList<{ a: number }>>>().toEqualTypeOf<ValueList<{ a: number }>>();
    expectTypeOf<Undraft<{ x: number; y: string[] }>>().toEqualTypeOf<{ x: number; y: string[] }>();
    produce(base, (d) => {
      expectTypeOf(current(d)).toEqualTypeOf<typeof base>();
      expectTypeOf(original(d.index)).toEqualTypeOf<ValueMap<string, { n: number }>>();
      expectTypeOf(current(d.items)).toEqualTypeOf<ValueList<number>>();
    });
  });
});
