// ---------------------------------------------------------------------------
// HashTable — the bucket table under memoize, on its own. memoize only ever
// removes an entry it holds, so through memoize half of `remove` never runs;
// here the table is given what memoize would not give it.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { HashTable, type TableEntry } from './hash-table.js';

interface E extends TableEntry {
  readonly name: string;
}
const entry = (hash: number, name: string): E => ({ hash, name });
const named = (name: string) => (e: E): boolean => e.name === name;

describe('HashTable', () => {
  it('finds by hash and match; a hash alone is not a match', () => {
    const t = new HashTable<E>();
    const a = entry(1, 'a');
    t.add(a);
    expect(t.find(1, named('a'))).toBe(a);
    expect(t.find(1, named('b'))).toBeUndefined();
    expect(t.find(2, named('a'))).toBeUndefined();
  });

  it('entries sharing a hash share a bucket, which grows and shrinks back to one', () => {
    const t = new HashTable<E>();
    const [a, b, c] = [entry(7, 'a'), entry(7, 'b'), entry(7, 'c')];
    t.add(a);
    t.add(b);
    t.add(c);
    for (const e of [a, b, c]) expect(t.find(7, named(e.name))).toBe(e);
    expect(t.find(7, named('d'))).toBeUndefined();

    expect(t.remove(b)).toBe(true); // from the middle
    expect(t.find(7, named('b'))).toBeUndefined();
    expect(t.remove(c)).toBe(true); // two down to one: the bucket is a single entry again
    expect(t.find(7, named('a'))).toBe(a);
    expect(t.remove(a)).toBe(true);
    expect(t.find(7, named('a'))).toBeUndefined();
    t.add(c); // and the hash is free to be used again
    expect(t.find(7, named('c'))).toBe(c);
  });

  it('removes by identity, and says when there was nothing to remove', () => {
    const t = new HashTable<E>();
    const a = entry(7, 'a');
    expect(t.remove(a)).toBe(false); // no bucket at all
    t.add(a);
    expect(t.remove(entry(7, 'a'))).toBe(false); // an equal entry is not THE entry (a single)
    t.add(entry(7, 'b'));
    expect(t.remove(entry(7, 'a'))).toBe(false); // nor in a shared bucket
    expect(t.find(7, named('a'))).toBe(a);
    expect(t.remove(a)).toBe(true);
    expect(t.remove(a)).toBe(false); // already gone
  });

  it('clear empties it', () => {
    const t = new HashTable<E>();
    const a = entry(1, 'a');
    t.add(a);
    t.add(entry(1, 'b'));
    t.clear();
    expect(t.find(1, named('a'))).toBeUndefined();
    expect(t.remove(a)).toBe(false);
  });
});
