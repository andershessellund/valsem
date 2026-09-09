// -0 never enters canonical state: every door normalises it to +0 (D22).
// `Object.is` is the only way to tell the two apart, so it is the assertion.
import { describe, it, expect } from 'vitest';
import { intern } from './intern.js';
import { ValueMap } from './value-map.js';
import { ValueSet } from './value-set.js';
import { ValueList } from './value-list.js';
import { RawArray } from './raw-array.js';
import { HashMap } from './hash-map.js';
import { produce } from './produce.js';
import { current } from './current.js';

const isPlusZero = (x: unknown): boolean => Object.is(x, 0);

describe('-0 is stored as +0', () => {
  it('intern: primitives, record fields, array elements, nested', () => {
    expect(isPlusZero(intern(-0))).toBe(true);
    expect(isPlusZero(intern(0))).toBe(true);
    expect(isPlusZero(intern({ x: -0 }).x)).toBe(true);
    expect(isPlusZero(intern([-0])[0])).toBe(true);
    expect(isPlusZero(intern({ a: [{ b: -0 }] }).a[0]!.b)).toBe(true);
    // One value, one instance — whichever spelling came first.
    expect(intern({ x: -0 })).toBe(intern({ x: 0 }));
    expect(intern([0, -0])).toBe(intern([-0, 0]));
  });

  it('ValueMap: keys and values, by every factory and by set', () => {
    const m = ValueMap.from<number, number>([[-0, -0]]);
    expect(isPlusZero([...m.keys()][0])).toBe(true);
    expect(isPlusZero(m.get(0))).toBe(true);
    expect(isPlusZero(m.get(-0))).toBe(true);
    expect(m).toBe(ValueMap.from([[0, 0]]));
    const s = ValueMap.empty<number, number>().set(-0, -0);
    expect(isPlusZero([...s.keys()][0])).toBe(true);
    expect(isPlusZero([...s.values()][0])).toBe(true);
    expect(isPlusZero(ValueMap.fromObject({ a: -0 }).get('a'))).toBe(true);
    // Overwriting +0 with -0 is not a change.
    expect(ValueMap.from([['a', 0]]).set('a', -0)).toBe(ValueMap.from([['a', 0]]));
  });

  it('ValueSet: members', () => {
    expect(isPlusZero([...ValueSet.from([-0])][0])).toBe(true);
    expect(isPlusZero([...ValueSet.empty<number>().add(-0)][0])).toBe(true);
    expect(ValueSet.from([-0])).toBe(ValueSet.from([0]));
    expect(isPlusZero([...ValueSet.from([1]).union([-0])].find((v) => v === 0))).toBe(true);
  });

  it('ValueList: of, push, set, splice, setMany, toArray', () => {
    expect(isPlusZero(ValueList.of(-0).get(0))).toBe(true);
    expect(isPlusZero(ValueList.empty<number>().push(-0).get(0))).toBe(true);
    expect(isPlusZero(ValueList.of(1).set(0, -0).get(0))).toBe(true);
    expect(isPlusZero(ValueList.of(1).splice(0, 0, [-0]).get(0))).toBe(true);
    expect(isPlusZero(ValueList.of(1, 2).setMany([[0, -0], [1, -0]]).get(1))).toBe(true);
    expect(isPlusZero(ValueList.of(-0).toArray()[0])).toBe(true);
    expect(ValueList.of(-0)).toBe(ValueList.of(0));
    expect(ValueList.of(0).set(0, -0)).toBe(ValueList.of(0));
  });

  it('produce: record fast path, new keys, grafted objects, arrays', () => {
    const base = intern({ x: 1, arr: [1, 2] as number[], o: { y: 1 } });
    const next = produce(base, (d) => {
      d.x = -0; // existing key: the incremental fast path
      (d as Record<string, unknown>)['z'] = -0; // new key
      d.o = { y: -0 }; // grafted foreign record: adopt
      d.arr[0] = -0; // array fast path
      d.arr.push(-0); // array append
    });
    expect(isPlusZero(next.x)).toBe(true);
    expect(isPlusZero((next as Record<string, unknown>)['z'])).toBe(true);
    expect(isPlusZero(next.o.y)).toBe(true);
    expect(isPlusZero(next.arr[0])).toBe(true);
    expect(isPlusZero(next.arr[2])).toBe(true);
    // A -0 write over a +0 is a no-op: the successor is the base.
    expect(produce(intern({ x: 0 }), (d) => { d.x = -0; })).toBe(intern({ x: 0 }));
  });

  it('produce: DraftMap values, DraftSet members, DraftList elements', () => {
    const base = intern({
      m: ValueMap.from<string, number>([['a', 1]]),
      s: ValueSet.from<number>([1]),
      l: ValueList.of<number>(1),
    });
    const next = produce(base, (d) => {
      d.m.set('a', -0);
      d.m.set('b', -0);
      d.s.add(-0);
      d.l.set(0, -0);
      d.l.push(-0);
    });
    expect(isPlusZero(next.m.get('a'))).toBe(true);
    expect(isPlusZero(next.m.get('b'))).toBe(true);
    expect(isPlusZero([...next.s].find((v) => v === 0))).toBe(true);
    expect(isPlusZero(next.l.get(0))).toBe(true);
    expect(isPlusZero(next.l.get(1))).toBe(true);
  });

  it('current(): the snapshot is canonical, so it holds +0', () => {
    produce(intern({ x: 1 }), (d) => {
      d.x = -0;
      expect(isPlusZero(current(d).x)).toBe(true);
    });
  });

  it('RawArray admission and HashMap keys', () => {
    expect(isPlusZero(RawArray.from([-0]).get(0))).toBe(true);
    expect(isPlusZero(RawArray.from([{ v: -0 }]).slice()[0]!.v)).toBe(true);
    const h = new HashMap<number, string>();
    h.set(-0, 'zero');
    expect(isPlusZero([...h.keys()][0])).toBe(true);
    expect(h.get(0)).toBe('zero');
  });
});
