// ---------------------------------------------------------------------------
// HashTable — the strong bucket table under HashMap's non-interning mode and
// memoize: hash → entry | entries, with the match supplied by the caller.
// The strong twin of the intern pool's `lookup(hash, matches)`: the caller
// owns hashing and equality (memoize folds its arguments and compares them
// `===`; HashMap uses `internHash`/`deepEqual`), the table owns buckets.
// Optionally insertion-ordered, for maps that iterate.
// ---------------------------------------------------------------------------

/** An entry the table can hold: anything carrying its own hash. */
export interface TableEntry {
  readonly hash: number;
}

/** @internal */
export class HashTable<E extends TableEntry> {
  readonly #buckets = new Map<number, E | E[]>();
  /** Insertion order, kept only when the owner iterates (`ordered`). */
  readonly #order: Set<E> | null;
  #size = 0;

  constructor(ordered: boolean) {
    this.#order = ordered ? new Set() : null;
  }

  get size(): number {
    return this.#size;
  }

  /** The entry under `hash` for which `match` holds, if any. */
  find(hash: number, match: (entry: E) => boolean): E | undefined {
    const b = this.#buckets.get(hash);
    if (b === undefined) return undefined;
    if (Array.isArray(b)) {
      for (let i = 0; i < b.length; i++) if (match(b[i]!)) return b[i];
      return undefined;
    }
    return match(b) ? b : undefined;
  }

  /** Insert `entry` (the caller has established no matching entry exists). */
  add(entry: E): void {
    const b = this.#buckets.get(entry.hash);
    if (b === undefined) this.#buckets.set(entry.hash, entry);
    else if (Array.isArray(b)) b.push(entry);
    else this.#buckets.set(entry.hash, [b, entry]);
    this.#order?.add(entry);
    this.#size++;
  }

  /** Remove `entry` (by identity). */
  remove(entry: E): boolean {
    const b = this.#buckets.get(entry.hash);
    if (b === undefined) return false;
    if (Array.isArray(b)) {
      const i = b.indexOf(entry);
      if (i === -1) return false;
      b.splice(i, 1);
      if (b.length === 1) this.#buckets.set(entry.hash, b[0]!);
    } else {
      if (b !== entry) return false;
      this.#buckets.delete(entry.hash);
    }
    this.#order?.delete(entry);
    this.#size--;
    return true;
  }

  clear(): void {
    this.#buckets.clear();
    this.#order?.clear();
    this.#size = 0;
  }

  /** Entries in insertion order (an ordered table only). */
  entries(): SetIterator<E> {
    if (this.#order === null) throw new Error('valsem: this HashTable is unordered');
    return this.#order.values();
  }
}
