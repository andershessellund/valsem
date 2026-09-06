// ---------------------------------------------------------------------------
// circle-pool — prototype incremental-sweep intern pool (benchmark candidate).
//
// All bucket records of all pools sharing a sweeper sit in ONE circular
// doubly-linked list. Every pool operation contributes a small deref budget
// that advances a global cursor around the circle; dead refs are removed as
// the cursor passes, and a record whose bucket empties is unlinked and
// deleted from its owner map (reached through a per-pool shared WeakRef —
// owner gone means just unlink). Cleanup is a bounded tax on traffic: no
// monolithic sweep pass, no per-entry FinalizationRegistry.
//
// Buckets inline the (overwhelmingly common under a seeded 32-bit hash)
// singleton case: `refs` is a single WeakRef until a genuine collision
// promotes it to an array; the sweeper demotes it back at one survivor.
//
// `gcBackstop` arms ONE FinalizationRegistry sentinel per sweeper: each GC
// epoch triggers a bounded sweep slice (half the circle, floor 1024), so a
// pool that goes fully idle is still reclaimed within a few GC epochs —
// O(1) FR cells in total, not one per entry.
// ---------------------------------------------------------------------------

const REGISTER_BUDGET = 2; // ref slots of sweep credit per register
const TICK_THRESHOLD = 16; // run the sweeper once this much credit accrues
const BACKSTOP_MAX_SLICE = 32_768; // cap per GC epoch — the slice is a pause too

export function createSweeper({ gcBackstop = false, lookupBudget = 1 } = {}) {
  // Sentinel keeps the circle non-empty; it is skipped free of charge.
  const sentinel = { hash: 0, owner: null, refs: null, prev: null, next: null };
  sentinel.prev = sentinel;
  sentinel.next = sentinel;

  const sweeper = {
    cursor: sentinel,
    slots: 0, // ref slots in the circle (live + not-yet-swept dead)
    pending: 0, // accrued sweep credit not yet spent
    lookupBudget,
    registry: null, // the backstop registry MUST be strongly held to keep firing

    tick(credit) {
      // Batch the fixed cost of a sweep call across TICK_THRESHOLD ops.
      sweeper.pending += credit;
      if (sweeper.pending >= TICK_THRESHOLD) {
        const budget = sweeper.pending;
        sweeper.pending = 0;
        sweeper.sweep(budget);
      }
    },

    link(record) {
      // Insert just behind the cursor: a fresh bucket is visited last.
      const at = sweeper.cursor;
      const p = at.prev;
      p.next = record;
      record.prev = p;
      record.next = at;
      at.prev = record;
    },

    sweep(budget) {
      let node = sweeper.cursor;
      while (budget > 0) {
        if (node === sentinel) {
          node = node.next;
          if (node === sentinel) break; // circle is empty
          continue;
        }
        const next = node.next;
        const refs = node.refs;
        // The owner WeakRef is deref'd ONLY on the removal path: live visits
        // (the overwhelmingly common case) touch just the ref itself. A
        // dropped pool's records with still-live values are simply visited as
        // live until those values die — the documented residual.
        if (Array.isArray(refs)) {
          budget -= refs.length;
          let w = 0;
          for (let r = 0; r < refs.length; r++) {
            if (refs[r].deref() !== undefined) refs[w++] = refs[r];
          }
          sweeper.slots -= refs.length - w;
          refs.length = w;
          if (w === 0) {
            node.owner.deref()?.delete(node.hash);
            unlink(node);
          } else if (w === 1) {
            node.refs = refs[0]; // demote to the singleton form
          }
        } else {
          budget -= 1;
          if (refs.deref() === undefined) {
            sweeper.slots -= 1;
            node.owner.deref()?.delete(node.hash);
            unlink(node);
          }
        }
        node = next;
      }
      sweeper.cursor = node;
    },
  };

  function unlink(record) {
    record.prev.next = record.next;
    record.next.prev = record.prev;
    record.prev = record.next = null;
  }

  if (gcBackstop) {
    // One sentinel object per GC epoch: its collection proves a GC ran (so
    // values may have died), triggering one bounded sweep slice. An
    // unreferenced FinalizationRegistry is itself collected and its callbacks
    // silently stop — hence the strong ref on the sweeper.
    const registry = new FinalizationRegistry(() => {
      sweeper.sweep(Math.min(Math.max(1024, sweeper.slots >> 1), BACKSTOP_MAX_SLICE));
      arm();
    });
    const arm = () => registry.register({}, 0);
    sweeper.registry = registry;
    arm();
  }

  return sweeper;
}

export function createCirclePool(sweeper) {
  const map = new Map(); // hash → bucket record
  const ownerRef = new WeakRef(map); // ONE shared WeakRef for all records

  return {
    lookup(hash, predicate) {
      if (sweeper.lookupBudget > 0) sweeper.tick(sweeper.lookupBudget);
      const rec = map.get(hash);
      if (rec === undefined) return undefined;
      const refs = rec.refs;
      if (Array.isArray(refs)) {
        for (const ref of refs) {
          const candidate = ref.deref();
          if (candidate !== undefined && predicate(candidate)) return candidate;
        }
        return undefined;
      }
      const candidate = refs.deref();
      return candidate !== undefined && predicate(candidate) ? candidate : undefined;
    },

    register(value, hash) {
      sweeper.tick(REGISTER_BUDGET);
      const rec = map.get(hash);
      if (rec === undefined) {
        const record = {
          hash,
          owner: ownerRef,
          refs: new WeakRef(value),
          prev: null,
          next: null,
        };
        map.set(hash, record);
        sweeper.link(record);
        sweeper.slots += 1;
      } else if (Array.isArray(rec.refs)) {
        // Prune dead in passing, then append.
        const arr = rec.refs;
        let w = 0;
        for (let r = 0; r < arr.length; r++) {
          if (arr[r].deref() !== undefined) arr[w++] = arr[r];
        }
        sweeper.slots -= arr.length - w;
        arr.length = w;
        arr.push(new WeakRef(value));
        sweeper.slots += 1;
      } else if (rec.refs.deref() === undefined) {
        rec.refs = new WeakRef(value); // replace the dead singleton in place
      } else {
        rec.refs = [rec.refs, new WeakRef(value)];
        sweeper.slots += 1;
      }
      return value;
    },

    live() {
      let n = 0;
      for (const rec of map.values()) {
        const refs = rec.refs;
        if (Array.isArray(refs)) {
          for (const ref of refs) if (ref.deref() !== undefined) n++;
        } else if (refs.deref() !== undefined) n++;
      }
      return n;
    },

    metaSlots() {
      let n = 0;
      for (const rec of map.values()) n += Array.isArray(rec.refs) ? rec.refs.length : 1;
      return n;
    },
  };
}
