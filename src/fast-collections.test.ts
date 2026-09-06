import { describe, it, expect } from 'vitest';
import { FastMap, FastSet } from './fast-collections.js';
import { intern } from './intern.js';
import { produce } from './produce.js';
import { ValueList } from './value-list.js';

describe('FastMap / FastSet', () => {
  it('keyed by canonical values: equal content is one key, at reference speed', () => {
    const m = new FastMap<object, number>();
    m.set(intern({ a: [1, 2] }), 1);
    expect(m.get(intern({ a: [1, 2] }))).toBe(1);
    expect(m.get(produce(intern({ a: [1, 3] }), (d) => void (d.a[1] = 2)))).toBe(1); // produced its way to the same value
    expect(m.get(ValueList.of(1))).toBeUndefined();
    const s = new FastSet<object>([ValueList.of(1, 2)]);
    expect(s.has(ValueList.of(1, 2))).toBe(true);
  });

  it('keeps the whole Map/Set surface — iteration, size, clear, forEach', () => {
    const k = intern({ id: 1 });
    const m = new FastMap<object, string>([[k, 'v']]);
    expect([...m]).toEqual([[k, 'v']]);
    expect([...m.entries()]).toEqual([[k, 'v']]);
    const seen: unknown[] = [];
    m.forEach((v, key) => seen.push([key, v]));
    expect(seen).toEqual([[k, 'v']]);
    m.clear();
    expect(m.size).toBe(0);
    const s = new FastSet<number>([1, 2, 2]);
    expect([...s]).toEqual([1, 2]);
    expect(s.delete(2)).toBe(true);
    expect(s.size).toBe(1);
  });

  it('a raw key is rejected on the way in and on lookup, naming the alternatives', () => {
    const m = new FastMap<object, number>();
    expect(() => m.set({ id: 1 }, 1)).toThrow(/FastMap takes canonical keys only/);
    expect(() => m.get({ id: 1 })).toThrow(/Intern it first .* or use HashMap to match by content/);
    expect(() => new FastMap([[{ id: 1 }, 1]])).toThrow(/canonical keys only/);
    expect(() => new FastSet([{ id: 1 }])).toThrow(/FastSet takes canonical elements only/);
    expect(() => new FastSet<unknown>().add(() => 1)).toThrow(/canonical elements only/);
  });
});
