// ---------------------------------------------------------------------------
// Shared by the OrderedMap and OrderedSet suites: where the runs of the
// backing ValueList start. A key that starts a run is an ANCHOR for the keys
// after it, so these are the positions where an insert or delete has the
// most to get right.
// ---------------------------------------------------------------------------
import type { ValueList } from './value-list.js';

/** The index at which each run (leaf, then the open tail) of `list` starts — where an inserted key becomes an anchor. */
export function runStarts(list: ValueList<unknown>): number[] {
  const { tree, tail } = list._structure();
  const starts: number[] = [];
  let pos = 0;
  const walk = (node: unknown[]): void => {
    if (node.length !== 0 && Array.isArray(node[0])) for (const kid of node) walk(kid as unknown[]);
    else {
      starts.push(pos);
      pos += node.length;
    }
  };
  if (tree !== null) walk(tree as unknown[]);
  if (tail.length !== 0) starts.push(pos);
  return starts;
}
