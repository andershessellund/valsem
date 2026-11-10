// `valsem/extend` — what a module needs in order to DEFINE a value type, and
// the main entry point without it (D69).
import { describe, it, expect } from 'vitest';
import * as extend from './extend.js';
import * as api from './index.js';
import * as draftKit from './draft.js';
import { deepEqual } from './deep-equal.js';
import { deepHash } from './deep-hash.js';
import { intern } from './intern.js';
import { HashMap } from './hash-map.js';
import type { Hasher } from './hasher.js';

describe('valsem/extend', () => {
  it('exports exactly the definition surface', () => {
    expect(Object.keys(extend).sort()).toEqual(
      ['createInternPool', 'equals', 'getHashSeed', 'hash', 'interned', 'mix', 'registerType'].sort(),
    );
  });

  it('none of it is in the main entry point, and neither is toDraft, which is valsem/draft', () => {
    for (const name of [...Object.keys(extend), 'toDraft', 'internHash']) expect(name in api, name).toBe(false);
    expect(typeof draftKit.toDraft).toBe('symbol');
  });

  it('the application switches stay in the main entry point', () => {
    for (const name of ['configureHasher', 'createMarvin32Hasher', 'configureLimits', 'skipChecks', 'skipFreezing']) {
      expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('a class is a value by the two symbols', () => {
    class Money {
      constructor(readonly amount: number, readonly currency: string) {}
      [extend.equals](o: unknown): boolean {
        return o instanceof Money && o.amount === this.amount && o.currency === this.currency;
      }
      [extend.hash](hasher: Hasher): number {
        return extend.mix(deepHash(this.amount, hasher), deepHash(this.currency, hasher));
      }
    }
    expect(deepEqual(new Money(5, 'EUR'), new Money(5, 'EUR'))).toBe(true);
    expect(intern(new Money(5, 'EUR'))).toBe(intern(new Money(5, 'EUR')));
    expect(new HashMap<Money, string>().set(new Money(5, 'EUR'), 'x').get(new Money(5, 'EUR'))).toBe('x');
  });

  it('registerType is the same declaration for a type that cannot be edited', () => {
    class Point {
      constructor(readonly x: number, readonly y: number) {}
    }
    expect(deepEqual(new Point(1, 2), new Point(1, 2))).toBe(false);
    extend.registerType(Point, (a, b) => a.x === b.x && a.y === b.y);
    expect(deepEqual(new Point(1, 2), new Point(1, 2))).toBe(true);
    expect(() => intern(new Point(1, 2))).toThrow(/hash/);
    extend.registerType(Point, (a, b) => a.x === b.x && a.y === b.y, (p, hasher) => deepHash([p.x, p.y], hasher));
    expect(intern(new Point(1, 2))).toBe(intern(new Point(1, 2)));
  });

  it('deepEqual no longer carries the registration', () => {
    expect('register' in deepEqual).toBe(false);
  });
});
