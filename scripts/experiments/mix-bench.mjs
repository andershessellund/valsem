// ---------------------------------------------------------------------------
// mix-bench — intern-pool indexes over mixes of inserts, lookup hits and deaths.
// The measurements behind D2 and D3. The contenders below `fr` are the road
// there, kept so that what was rejected can be re-run.
//
// Contenders (same lookup(hash, predicate) / register(value, hash) interface):
//   shipped        dist/intern-pool.js as built: the open table swept in place (its
//                  probes, epochs and gate are `psweep pause w64` below; plus the
//                  idle driver and the shrink hysteresis, which only it has)
//   fr             fr-pool.mjs, the pool it replaced: 64 Map shards, WeakRef
//                  slots, one FinalizationRegistry, idle-time reclaim
//   semi K [opts]  the prototype the shipped index was developed as, kept so the
//                  rejected variants can be re-run. 64 lazy shards, one int32
//                  per slot (24 hash bits | 8-bit epoch) plus a refs array; K
//                  live copies per insert from `old` to `cur`, the dead are not
//                  copied; a WeakRef canary counts major GCs. Options:
//                    gateF  verify only when a 64-slot sample finds >= F dead
//                           (without it: a verifying lap after every collection)
//                    +hits  a lookup hit in `old` moves the entry to `cur`
//                    bN     spend the migration credit once every N inserts
//                  "semi 1 gate.5" is the shipped configuration.
//   chain [opts]   a chained alternative: a Slot subclass of WeakRef carrying its
//                  hash and a next pointer; segmented LINEAR HASHING (one bucket
//                  splits per insert, in place, and a lookup has one place to
//                  look); cleanup is an adaptive sweep that unlinks the dead —
//                  checks per insert = 4 x (the fraction of the last 16 checks
//                  that found a dead slot), between a floor and a cap. No
//                  canary, no epochs, no second table, no shards. Options:
//                    capN   at most N checks per insert (default 2)
//                    gainG  checks per insert = G x that fraction (default 4);
//                           steady churn settles at a dead fraction of 1/sqrt(G)
//                    +reads lookups advance the sweep too
//   sweep [capN]   the open table of `shipped` (one int32 tag per slot, 64 shards)
//                  with `chain`'s cleanup: an adaptive sweep, in place, deleting
//                  by backward shift. Growth (and shrinking) is an incremental
//                  PLAIN copy, 4 entries per insert, sized exactly — so nothing
//                  is allocated because of a collection. No canary, no epochs,
//                  no survivor sample, no overflow path.
//   gsweep [gateF] `shipped`'s policy on `sweep`'s mechanism: the canary, the epoch
//                  stamps and the once-per-pool dead-fraction gate decide WHEN a
//                  shard is verified; the verification is a pass IN PLACE (stamped
//                  entries skipped untouched, the living restamped, the dead
//                  removed by backward shift), so a collection allocates nothing.
//                  Tables are replaced only to grow or shrink: an incremental
//                  copy sized exactly, which verifies as it goes if a pass is due.
//   psweep [gateF] `gsweep` without the canary and without the 64-slot sample: the
//                  pool's OWN entries are the canaries. One stamp-blind probe per
//                  32 registrations; a dead entry found carrying the CURRENT stamp
//                  proves a collection happened in this epoch, so the epoch
//                  advances (and 16 more probes refresh the estimate). The dead
//                  fraction of the last 16 checks is the gate. Looking at a
//                  WeakRef pins it; of these we do not care.
//   null, wr       ablations: the harness alone, and the harness plus one
//                  retained WeakRef per insert
//
// Method. Every measurement is its own process. Major GCs are FORCED every G
// inserts, so every run of a scenario sees the same epochs (with natural GC
// timing the same configuration measured anywhere from 134 to 192 ns/op).
// Reported per scenario: ns per operation over the timed batches; time inside
// the forced GCs; time in the event-loop turns between batches (where
// finalization callbacks and an idle drain run); the slowest batch; entries
// still stored at the end; and heap + array buffers after a final collection.
// Forced GCs are atomic where natural ones are incremental, and one per 200k
// inserts over a million live entries is more often than V8 would choose —
// compare columns, do not read them as production latencies.
//
// Env: ONLY (comma-separated substrings: run just the scenarios that match),
// BATCH (inserts per job, default 5000), HOT (hits go to the first HOT
// live members, default all), PROF=<file> (CPU profile of the timed phase),
// RUNTIME=<binary> (run the measuring processes under it instead of this node:
// the pinned Bun, for JavaScriptCore — see bench/fetch-engines.mjs).
//
// Run: pnpm build && node scripts/experiments/mix-bench.mjs [rounds] [pool,pool,…]
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BATCH = Number(process.env.BATCH ?? 5_000);
const HOT = Number(process.env.HOT ?? 0);

const SCENARIOS = {
  // name: { prefill, phases: [{ inserts, hitsPerInsert, targetW }], gcEvery }
  'churn 50k, no hits': { prefill: 50_000, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 50_000 }] },
  'churn 50k, 4 hits/ins': { prefill: 50_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 4, w: 50_000 }] },
  'churn 1M, no hits': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 1_000_000 }] },
  // Thirty epochs: long enough for a high dead-fraction threshold to be reached, and reached again.
  'long churn 1M, no hits': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 6_000_000, hits: 0, w: 1_000_000 }] },
  'churn 1M, 4 hits/ins': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 4, w: 1_000_000 }] },
  'read-mostly 1M, 16 hits/ins': { prefill: 1_000_000, gcEvery: 50_000, phases: [{ inserts: 250_000, hits: 16, w: 1_000_000 }] },
  'grow to 2M, no deaths': { prefill: 0, gcEvery: 200_000, phases: [{ inserts: 2_000_000, hits: 0, w: 2_000_000 }] },
  'collapse 1M→50k, then churn': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 1_000_000, hits: 1, w: 50_000 }] },
  // A mass death followed by mass creation: is giving the space back worth it?
  'collapse 1M→50k, churn a little, regrow to 1M': { prefill: 1_000_000, gcEvery: 200_000, phases: [{ inserts: 400_000, hits: 1, w: 50_000 }, { inserts: 1_000_000, hits: 1, w: 1_000_000 }] },
  // NO forced collections: the engine's own, incremental and mid-job — the normal case, and the one
  // a liveness signal has to survive. `stored` is read before the harness's final collections.
  'natural GC: churn 50k, 3M inserts': { prefill: 50_000, gcEvery: Infinity, junk: true, phases: [{ inserts: 3_000_000, hits: 0, w: 50_000 }] },
  'natural GC: churn 50k, 4 hits/ins': { prefill: 50_000, gcEvery: Infinity, junk: true, phases: [{ inserts: 1_500_000, hits: 4, w: 50_000 }] },
  // What `pnpm bench` sees: churn (untimed), settle as bench/lib.mjs does (forced
  // collections and idle turns, where a registry-driven pool cleans up), then
  // time a short burst. ns/op is the burst alone.
  'burst of 200 after churn + settle': { prefill: 10_000, burst: { rounds: 40, churn: 20_000, timed: 200, w: 10_000 } },
};

const POOLS = process.argv[3] && process.argv[2] !== 'child' ? process.argv[3].split(',') : ['fr', 'shipped'];

// --- the semispace pool -------------------------------------------------------

class Table {
  constructor(p, cleanedEpoch) {
    this.p = p;
    this.cap = 1 << p;
    this.mask = this.cap - 1;
    this.shift = 32 - p;
    this.M = new Int32Array(this.cap);
    this.R = new Array(this.cap).fill(undefined);
    this.used = 0;
    this.oM = null;
    this.oR = null;
    this.oCap = 0;
    this.oMask = 0;
    this.oShift = 0;
    this.cursor = 0;
    this.credit = 0;
    this.cleanedEpoch = cleanedEpoch;
    this.verify = true;
    this.pending = 0;
    this.batchN = 1;
  }
}

// theta > 0: a verifying (dereferencing) cycle runs only when a 64-slot sample
// finds at least that fraction dead; otherwise a GC is ignored, and growth is a
// plain copy that keeps every stamp.
// batch > 1: migration credit accumulates and is spent once every `batch`
// inserts to the shard (capped at 1/16 of the table, so a small shard cannot
// fill while it waits).
function makeSemiPool(K, hitMigrates, theta = 0, batch = 1) {
  const shards = new Array(64).fill(undefined);
  let canary = new WeakRef({});
  let epoch = 1;
  let ep8 = 1;
  let tick = 0;
  const st = { cycles: 0, forced: 0, byHit: 0, skipped: 0, derefLive: 0, derefDead: 0 };

  function place(t, word, r) {
    const M = t.M;
    const mask = t.mask;
    let i = (word & ~0xff) >>> t.shift;
    while (M[i] !== 0) i = (i + 1) & mask;
    M[i] = word;
    t.R[i] = r;
    t.used++;
  }

  // Survivor estimate: 64 occupied slots from a random start.
  function sample(t) {
    let live = 0;
    let seen = 0;
    let i = (Math.random() * t.cap) | 0;
    for (let g = 0; seen < 64 && g < 4096; g++, i = (i + 1) & t.mask) {
      const w = t.M[i];
      if (w === 0) continue;
      seen++;
      if ((w & 0xff) === ep8 || t.R[i].deref() !== undefined) live++;
    }
    return seen === 0 ? 1 : live / seen;
  }

  function start(t, f, verify) {
    t.verify = verify;
    t.pending = 0;
    const expected = t.used * Math.min(1, f + 0.1) * (1 + 1 / K) + 16;
    let p = 6;
    while ((1 << p) * 0.45 < expected) p++;
    t.oM = t.M;
    t.oR = t.R;
    t.oCap = t.cap;
    t.oMask = t.mask;
    t.oShift = t.shift;
    t.cursor = 0;
    t.cleanedEpoch = epoch;
    t.p = p;
    t.cap = 1 << p;
    t.mask = t.cap - 1;
    t.shift = 32 - p;
    t.M = new Int32Array(t.cap);
    t.R = new Array(t.cap).fill(undefined);
    t.used = 0;
    t.batchN = Math.max(1, Math.min(batch, t.cap >> 4));
    st.cycles++;
  }

  function migrate(t, budget, slots) {
    const oM = t.oM;
    const oR = t.oR;
    const oCap = t.oCap;
    let c = t.cursor;
    while (budget > 0 && slots-- > 0 && c < oCap) {
      const w = oM[c];
      if (w !== 0) {
        const r = oR[c];
        if (r !== undefined) {
          if (!t.verify || (w & 0xff) === ep8) {
            st.skipped++;
            place(t, w, r);
            budget--;
          } else if (r.deref() !== undefined) {
            st.derefLive++;
            place(t, (w & ~0xff) | ep8, r);
            budget--;
          } else st.derefDead++;
        }
      }
      c++;
    }
    t.cursor = c;
    if (c >= oCap) {
      t.oM = null;
      t.oR = null;
    }
  }

  // cur is filling before old has drained: the survivor sample was too low.
  // If the rest of old might not fit, move cur (stamps kept, no deref) into a
  // table sized for everything, then drain old into that.
  function forceFinish(t) {
    let rem = 0;
    for (let c = t.cursor; c < t.oCap; c++) if (t.oM[c] !== 0 && t.oR[c] !== undefined) rem++;
    const need = t.used + rem + 16;
    if (need > t.cap * 0.6) {
      const cM = t.M;
      const cR = t.R;
      const cCap = t.cap;
      let p = t.p;
      while ((1 << p) * 0.45 < need) p++;
      t.p = p;
      t.cap = 1 << p;
      t.mask = t.cap - 1;
      t.shift = 32 - p;
      t.M = new Int32Array(t.cap);
      t.R = new Array(t.cap).fill(undefined);
      t.used = 0;
      for (let i = 0; i < cCap; i++) if (cM[i] !== 0) place(t, cM[i], cR[i]);
    }
    migrate(t, t.oCap, t.oCap);
  }

  return {
    lookup(hash, predicate) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = shards[m >>> 26];
      if (t === undefined) return undefined;
      const tag = (m << 6) & ~0xff;
      const M = t.M;
      let i = tag >>> t.shift;
      for (;;) {
        const w = M[i];
        if (w === 0) break;
        if ((w & ~0xff) === tag) {
          const v = t.R[i].deref();
          if (v !== undefined && predicate(v)) {
            if ((w & 0xff) !== ep8) M[i] = tag | ep8;
            return v;
          }
        }
        i = (i + 1) & t.mask;
      }
      const oM = t.oM;
      if (oM !== null) {
        i = tag >>> t.oShift;
        for (;;) {
          const w = oM[i];
          if (w === 0) break;
          if ((w & ~0xff) === tag) {
            const r = t.oR[i];
            if (r !== undefined) {
              const v = r.deref();
              if (v !== undefined && predicate(v)) {
                if (hitMigrates && i >= t.cursor) {
                  t.oR[i] = undefined;
                  place(t, tag | ep8, r);
                  st.byHit++;
                } else if ((w & 0xff) !== ep8) oM[i] = tag | ep8;
                return v;
              }
            }
          }
          i = (i + 1) & t.oMask;
        }
      }
      return undefined;
    },
    register(value, hash) {
      if ((++tick & 63) === 0 && canary.deref() === undefined) {
        canary = new WeakRef({});
        epoch++;
        ep8 = ((epoch - 1) % 255) + 1;
      }
      const m = Math.imul(hash, 0x9e3779b1);
      const s = m >>> 26;
      let t = shards[s];
      if (t === undefined) t = shards[s] = new Table(6, epoch);
      if (t.oM !== null) {
        t.credit += K;
        if (++t.pending >= t.batchN) {
          t.pending = 0;
          const n = t.credit | 0;
          if (n > 0) {
            t.credit -= n;
            migrate(t, n, 64 * n);
          }
        }
        if (t.oM !== null && t.used >= t.cap * 0.75) {
          st.forced++;
          forceFinish(t);
        }
      }
      if (t.oM === null) {
        const grow = t.used >= t.cap >> 1;
        if (grow || (t.cleanedEpoch !== epoch && t.used > 32)) {
          if (theta === 0) start(t, t.cleanedEpoch !== epoch ? sample(t) : 1, true);
          else {
            const f = sample(t);
            if (1 - f >= theta) start(t, f, true);
            else if (grow) start(t, 1, false);
            t.cleanedEpoch = epoch;
          }
        }
      }
      place(t, ((m << 6) & ~0xff) | ep8, new WeakRef(value));
      return value;
    },
    stats() {
      let stored = 0;
      let slots = 0;
      for (const t of shards) {
        if (t === undefined) continue;
        stored += t.used;
        slots += t.cap + (t.oM !== null ? t.oCap : 0);
      }
      return { stored, slots, epochs: epoch - 1, ...st };
    },
  };
}

// --- the chained pool ---------------------------------------------------------

function makeChainPool(cap, onReads, gain = 4, presize = false) {
  class Slot extends WeakRef {
    constructor(target, hash) {
      super(target);
      this.hash = hash;
      this.next = undefined;
    }
  }
  const SEG_BITS = 12;
  const SEG = 1 << SEG_BITS;
  const FLOOR = 1 / 32;
  const segs = [new Array(SEG).fill(undefined)];
  if (presize) for (let k = 1; k < 1024; k++) segs.push(new Array(SEG).fill(undefined));
  let n = presize ? 1 << 22 : 64; // buckets at the start of this round of splitting
  let p = 0; // next bucket to split; buckets below it use the wider mask
  let count = 0;
  let cursor = 0;
  let hist = 0; // the last 16 checks, one bit each: found dead?
  let dead16 = 0;
  let credit = 0;
  const st = { splits: 0, checks: 0, unlinked: 0, checkedLive: 0 };
  const mix = (hash) => { const m = Math.imul(hash, 0x9e3779b1); return m ^ (m >>> 15); };
  const bucketOf = (x) => { const i = x & (n - 1); return i < p ? x & (2 * n - 1) : i; };

  function record(dead) {
    dead16 += dead - ((hist >>> 15) & 1);
    hist = ((hist << 1) | dead) & 0xffff;
  }
  /** Walk one bucket, unlinking the dead. Returns the checks it cost. */
  function sweepBucket(i) {
    const seg = segs[i >>> SEG_BITS];
    const k = i & (SEG - 1);
    let prev;
    let cost = 0.25; // an empty bucket is a head load
    for (let sl = seg[k]; sl !== undefined; sl = sl.next) {
      cost++;
      st.checks++;
      if (sl.deref() === undefined) {
        if (prev === undefined) seg[k] = sl.next; else prev.next = sl.next;
        count--;
        st.unlinked++;
        record(1);
      } else {
        prev = sl;
        st.checkedLive++;
        record(0);
      }
    }
    return cost;
  }
  function sweep() {
    if (cap === 0) return;
    credit += Math.min(cap, Math.max(FLOOR, (dead16 * gain) / 16));
    while (credit >= 1) {
      credit -= sweepBucket(cursor);
      if (++cursor >= n + p) cursor = 0;
    }
  }
  function split() {
    const to = n + p;
    if ((to & (SEG - 1)) === 0 && segs.length <= to >>> SEG_BITS) segs.push(new Array(SEG).fill(undefined));
    const seg = segs[p >>> SEG_BITS];
    const k = p & (SEG - 1);
    const hi = segs[to >>> SEG_BITS];
    const hk = to & (SEG - 1);
    let keep;
    let move;
    for (let sl = seg[k], next; sl !== undefined; sl = next) {
      next = sl.next;
      if ((mix(sl.hash) & n) === 0) { sl.next = keep; keep = sl; } else { sl.next = move; move = sl; }
    }
    seg[k] = keep;
    hi[hk] = move;
    st.splits++;
    if (++p === n) { n *= 2; p = 0; }
  }
  return {
    lookup(hash, predicate) {
      const i = bucketOf(mix(hash));
      for (let sl = segs[i >>> SEG_BITS][i & (SEG - 1)]; sl !== undefined; sl = sl.next) {
        if (sl.hash !== hash) continue;
        const v = sl.deref();
        if (v !== undefined && predicate(v)) { if (onReads) sweep(); return v; }
      }
      if (onReads) sweep();
      return undefined;
    },
    register(value, hash) {
      if (count >= n + p && !presize) split(); // one entry per bucket, on average
      sweep();
      const i = bucketOf(mix(hash));
      const seg = segs[i >>> SEG_BITS];
      const sl = new Slot(value, hash);
      sl.next = seg[i & (SEG - 1)];
      seg[i & (SEG - 1)] = sl;
      count++;
      return value;
    },
    stats: () => ({ stored: count, slots: n + p, epochs: 0, cycles: st.splits, forced: 0, byHit: 0, skipped: 0, derefLive: st.checkedLive, derefDead: st.unlinked }),
  };
}

// --- the swept open table -----------------------------------------------------

function makeSweepPool(cap, gain = 4, batch = 1, noDelete = false) {
  const MIN_BITS = 6;
  const FLOOR = 1 / 32;
  const shards = new Array(64).fill(undefined);
  let hist = 0;
  let dead16 = 0;
  let credit = 0;
  const st = { cycles: 0, checkedLive: 0, removed: 0 };
  const newShard = () => ({ bits: MIN_BITS, words: new Int32Array(1 << MIN_BITS), refs: new Array(1 << MIN_BITS).fill(undefined), used: 0, oldBits: 0, oldWords: null, oldRefs: null, cursor: 0, sweepAt: 0 });
  function record(dead) {
    dead16 += dead - ((hist >>> 15) & 1);
    hist = ((hist << 1) | dead) & 0xffff;
  }
  function place(t, word, ref) {
    const words = t.words;
    const mask = words.length - 1;
    let i = word >>> (32 - t.bits);
    while (words[i] !== 0) i = (i + 1) & mask;
    words[i] = word;
    t.refs[i] = ref;
    t.used++;
  }
  /** Linear probing's deletion without tombstones: close the gap with whatever may legally move back. */
  function removeAt(t, i) {
    const words = t.words;
    const refs = t.refs;
    const mask = words.length - 1;
    const shift = 32 - t.bits;
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      const w = words[j];
      if (w === 0) break;
      const home = w >>> shift;
      if (i <= j ? i < home && home <= j : i < home || home <= j) continue;
      words[i] = w;
      refs[i] = refs[j];
      i = j;
    }
    words[i] = 0;
    refs[i] = undefined;
    t.used--;
  }
  function sweep(t) {
    if (cap === 0) return;
    credit += Math.min(cap, Math.max(FLOOR, (dead16 * gain) / 16));
    if (credit < batch) return; // spend the checks together: independent loads overlap
    const words = t.words;
    const mask = words.length - 1;
    let at = t.sweepAt & mask;
    while (credit >= 1) {
      if (words[at] === 0) {
        credit -= 1 / 16;
        at = (at + 1) & mask;
      } else if (t.refs[at].deref() === undefined) {
        if (noDelete) at = (at + 1) & mask; // ablation: pay the check, skip the backward shift
        else removeAt(t, at); // stay: what shifted back into this slot is unchecked
        st.removed++;
        record(1);
        credit -= 1;
      } else {
        st.checkedLive++;
        record(0);
        credit -= 1;
        at = (at + 1) & mask;
      }
    }
    t.sweepAt = at;
  }
  function beginCopy(t, bits) {
    t.oldBits = t.bits;
    t.oldWords = t.words;
    t.oldRefs = t.refs;
    t.cursor = 0;
    t.bits = bits;
    t.words = new Int32Array(1 << bits);
    t.refs = new Array(1 << bits).fill(undefined);
    t.used = 0;
    t.sweepAt = 0;
    st.cycles++;
  }
  function copy(t, entries, slots) {
    const oldWords = t.oldWords;
    const end = oldWords.length;
    const checking = dead16 >= 4; // the sweep is finding the dead: do not carry them over
    let c = t.cursor;
    while (entries > 0 && slots-- > 0 && c < end) {
      const w = oldWords[c];
      if (w !== 0) {
        const ref = t.oldRefs[c];
        if (checking && ref.deref() === undefined) { st.removed++; record(1); }
        else { place(t, w, ref); entries--; }
      }
      c++;
    }
    t.cursor = c;
    if (c >= end) { t.oldWords = null; t.oldRefs = null; }
  }
  return {
    lookup(hash, predicate) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = shards[m >>> 26];
      if (t === undefined) return undefined;
      const tag = (m << 6) | 1; // low bits spare; never zero
      let words = t.words;
      let mask = words.length - 1;
      let i = tag >>> (32 - t.bits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if (w !== tag) continue;
        const v = t.refs[i].deref();
        if (v !== undefined && predicate(v)) return v;
      }
      words = t.oldWords;
      if (words === null) return undefined;
      mask = words.length - 1;
      i = tag >>> (32 - t.oldBits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if (w !== tag) continue;
        const v = t.oldRefs[i].deref();
        if (v !== undefined && predicate(v)) return v;
      }
      return undefined;
    },
    register(value, hash) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = (shards[m >>> 26] ??= newShard());
      if (t.oldWords !== null) copy(t, 4, 64);
      else {
        const size = t.words.length;
        if (t.used >= size >> 1 || (t.used < size >> 4 && t.bits > MIN_BITS)) {
          // sized exactly: what is there, plus what arrives while it is copied
          const arriving = Math.max(t.used / 4, size / 64);
          let bits = MIN_BITS;
          while ((1 << bits) * 0.45 < t.used + arriving + 16) bits++;
          if (bits !== t.bits) beginCopy(t, bits);
          else sweep(t);
        } else sweep(t);
      }
      place(t, (m << 6) | 1, new WeakRef(value));
      return value;
    },
    stats() {
      let stored = 0;
      let slots = 0;
      for (const t of shards) if (t !== undefined) { stored += t.used; slots += t.words.length + (t.oldWords !== null ? t.oldWords.length : 0); }
      return { stored, slots, epochs: 0, cycles: st.cycles, forced: 0, byHit: 0, skipped: 0, derefLive: st.checkedLive, derefDead: st.removed };
    },
  };
}

// --- gated passes, in place ---------------------------------------------------

function makeGatedSweepPool(theta, LIVE = 2, shrink = true) {
  const MIN_BITS = 6;
  const STAMP = 63;
  const SLOTS = 16; // slots a registration may pass
  // LIVE: …or living entries it may dereference, whichever comes first
  const shards = new Array(64).fill(undefined);
  let canary = new WeakRef({});
  let epoch = 1;
  let stamp = 1;
  let tick = 0;
  let sampled = 0;
  let survivors = 1;
  const st = { copies: 0, passes: 0, skipped: 0, checkedLive: 0, removed: 0, shiftCalls: 0, shiftScanned: 0, shiftMoved: 0 };
  const newShard = () => ({ bits: MIN_BITS, words: new Int32Array(1 << MIN_BITS), refs: new Array(1 << MIN_BITS).fill(undefined), used: 0, oldBits: 0, oldWords: null, oldRefs: null, cursor: 0, verify: false, answered: epoch, passAt: 0, passLeft: 0 });
  function place(t, word, ref) {
    const words = t.words;
    const mask = words.length - 1;
    let i = (word & ~STAMP) >>> (32 - t.bits);
    while (words[i] !== 0) i = (i + 1) & mask;
    words[i] = word;
    t.refs[i] = ref;
    t.used++;
  }
  function removeAt(t, i) {
    const words = t.words;
    const refs = t.refs;
    const mask = words.length - 1;
    const shift = 32 - t.bits;
    let j = i;
    st.shiftCalls++;
    for (;;) {
      j = (j + 1) & mask;
      const w = words[j];
      if (w === 0) break;
      st.shiftScanned++;
      const home = (w & ~STAMP) >>> shift;
      if (i <= j ? i < home && home <= j : i < home || home <= j) continue;
      words[i] = w;
      refs[i] = refs[j];
      i = j;
      st.shiftMoved++;
    }
    words[i] = 0;
    refs[i] = undefined;
    t.used--;
  }
  function sample(t) {
    const words = t.words;
    const mask = words.length - 1;
    let live = 0;
    let seen = 0;
    let i = (Math.random() * words.length) | 0;
    for (let passed = 0; seen < 64 && passed <= mask; passed++, i = (i + 1) & mask) {
      const w = words[i];
      if (w === 0) continue;
      seen++;
      if ((w & STAMP) === stamp || t.refs[i].deref() !== undefined) live++;
    }
    return live / seen;
  }
  function beginCopy(t, verify) {
    const size = t.words.length;
    let bits = MIN_BITS;
    while ((1 << bits) * 0.45 < t.used + Math.max(t.used / 4, size / SLOTS) + 16) bits++;
    if (bits === t.bits && !verify) return false;
    t.oldBits = t.bits;
    t.oldWords = t.words;
    t.oldRefs = t.refs;
    t.cursor = 0;
    t.verify = verify;
    t.passLeft = 0;
    t.bits = bits;
    t.words = new Int32Array(1 << bits);
    t.refs = new Array(1 << bits).fill(undefined);
    t.used = 0;
    t.passAt = 0;
    st.copies++;
    return true;
  }
  function copy(t) {
    const oldWords = t.oldWords;
    const end = oldWords.length;
    let c = t.cursor;
    let entries = 4;
    let slots = SLOTS;
    while (entries > 0 && slots-- > 0 && c < end) {
      const w = oldWords[c];
      if (w !== 0) {
        const ref = t.oldRefs[c];
        if (!t.verify || (w & STAMP) === stamp) { place(t, w, ref); entries--; }
        else if (ref.deref() !== undefined) { place(t, (w & ~STAMP) | stamp, ref); entries -= 2; st.checkedLive++; }
        else st.removed++;
      }
      c++;
    }
    t.cursor = c;
    if (c >= end) { t.oldWords = null; t.oldRefs = null; }
  }
  function pass(t) {
    const words = t.words;
    const mask = words.length - 1;
    let at = t.passAt & mask;
    let slots = SLOTS;
    let live = LIVE;
    while (slots-- > 0 && live > 0 && t.passLeft > 0) {
      const w = words[at];
      if (w === 0 || (w & STAMP) === stamp) {
        if (w !== 0) st.skipped++;
        at = (at + 1) & mask;
        t.passLeft--;
      } else if (t.refs[at].deref() === undefined) {
        removeAt(t, at); // stay: what shifted back into this slot has not been looked at
        st.removed++;
      } else {
        words[at] = (w & ~STAMP) | stamp;
        st.checkedLive++;
        live--;
        at = (at + 1) & mask;
        t.passLeft--;
      }
    }
    t.passAt = at;
    // a pass that emptied the table leaves it to be replaced by a smaller one
    if (shrink && t.passLeft <= 0 && t.used < words.length >> 3 && t.bits > MIN_BITS) beginCopy(t, false);
  }
  return {
    lookup(hash, predicate) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = shards[m >>> 26];
      if (t === undefined) return undefined;
      const tag = m << 6;
      let words = t.words;
      let mask = words.length - 1;
      let i = tag >>> (32 - t.bits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if ((w & ~STAMP) !== tag) continue;
        const v = t.refs[i].deref();
        if (v !== undefined && predicate(v)) { if ((w & STAMP) !== stamp) words[i] = tag | stamp; return v; }
      }
      words = t.oldWords;
      if (words === null) return undefined;
      mask = words.length - 1;
      i = tag >>> (32 - t.oldBits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if ((w & ~STAMP) !== tag) continue;
        const v = t.oldRefs[i].deref();
        if (v !== undefined && predicate(v)) { if ((w & STAMP) !== stamp) words[i] = tag | stamp; return v; }
      }
      return undefined;
    },
    register(value, hash) {
      if ((++tick & 63) === 0 && canary.deref() === undefined) { canary = new WeakRef({}); epoch++; stamp = ((epoch - 1) % STAMP) + 1; }
      const m = Math.imul(hash, 0x9e3779b1);
      const t = (shards[m >>> 26] ??= newShard());
      if (t.oldWords !== null) copy(t);
      else {
        const full = t.used >= t.words.length >> 1;
        if (t.answered !== epoch && (full || t.used > 32)) {
          t.answered = epoch;
          if (sampled !== epoch) { sampled = epoch; survivors = sample(t); }
          if (1 - survivors >= theta) { st.passes++; t.passLeft = t.words.length; }
        }
        if (full) beginCopy(t, t.passLeft > 0); // growing anyway: let the copy do the verifying
        else if (t.passLeft > 0) pass(t);
      }
      place(t, (m << 6) | stamp, new WeakRef(value));
      return value;
    },
    stats() {
      let stored = 0;
      let slots = 0;
      for (const t of shards) {
        if (t === undefined) continue;
        stored += t.used;
        slots += t.words.length;
        if (t.oldWords !== null) { slots += t.oldWords.length; for (let c = t.cursor; c < t.oldWords.length; c++) if (t.oldWords[c] !== 0) stored++; }
      }
      return { shift: st.shiftCalls ? `${st.shiftCalls} removals, ${(st.shiftScanned / st.shiftCalls).toFixed(2)} slots scanned and ${(st.shiftMoved / st.shiftCalls).toFixed(2)} entries moved per removal` : '', stored, slots, epochs: epoch - 1, cycles: st.copies, forced: st.passes, byHit: 0, skipped: st.skipped, derefLive: st.checkedLive, derefDead: st.removed };
    },
  };
}

// --- probes instead of a canary -----------------------------------------------

function makeProbeSweepPool(theta, cursorMode = 'rand', WINDOW = 16) {
  // WINDOW — the checks the dead-fraction gate looks back over. A noticed collection is followed
  // by WINDOW probes, so that the estimate the gate then uses is wholly from after it.
  // cursorMode — where a probe looks: 'rand' a random slot each time; 'restart' the shard's
  // sweep cursor, set to a random slot after each table copy; 'scaled' the sweep cursor,
  // carried across a copy by scaling it (high-bit indexing preserves order: slot i → ~2i);
  // 'follow' as 'scaled', and while a table is being copied the cursor works wherever its
  // entries ARE: in the old array while the copy has not reached them (a dead entry there is
  // blanked, not shifted — its word keeps the old chains valid and the copy skips it), in
  // the new array once it has. Sweeps do not wait for a copy to end;
  // 'pause' as 'scaled', but a shard that is copying does no cleaning at all: no probes, no
  // sweep, and the copy is always a plain one (it never dereferences).
  const MIN_BITS = 6;
  const STAMP = 63;
  const SLOTS = 16;
  const LIVE = 1;
  const PROBE_EVERY = 32;
  const BURST = WINDOW;
  const ring = new Uint8Array(WINDOW);
  let ringAt = 0;
  const shards = new Array(64).fill(undefined);
  let epoch = 1;
  let stamp = 1;
  let tick = 0;
  let dead16 = 0;
  const st = { copies: 0, laps: 0, skipped: 0, checkedLive: 0, removed: 0, probes: 0 };
  const newShard = () => ({ bits: MIN_BITS, words: new Int32Array(1 << MIN_BITS), refs: new Array(1 << MIN_BITS).fill(undefined), used: 0, oldBits: 0, oldWords: null, oldRefs: null, cursor: 0, verify: false, answered: epoch, at: 0, sweepLeft: 0 });
  function record(dead) {
    dead16 += dead - ring[ringAt];
    ring[ringAt] = dead;
    ringAt = (ringAt + 1) & (WINDOW - 1);
  }
  function place(t, word, ref) {
    const words = t.words;
    const mask = words.length - 1;
    let i = (word & ~STAMP) >>> (32 - t.bits);
    while (words[i] !== 0) i = (i + 1) & mask;
    words[i] = word;
    t.refs[i] = ref;
    t.used++;
  }
  function removeAt(t, i) {
    const words = t.words;
    const refs = t.refs;
    const mask = words.length - 1;
    const shift = 32 - t.bits;
    for (let j = (i + 1) & mask, w = words[j]; w !== 0; j = (j + 1) & mask, w = words[j]) {
      const home = (w & ~STAMP) >>> shift;
      if (i <= j ? i < home && home <= j : i < home || home <= j) continue;
      words[i] = w;
      refs[i] = refs[j];
      i = j;
    }
    words[i] = 0;
    refs[i] = undefined;
    t.used--;
  }
  /** Dereference up to `n` occupied slots from a RANDOM place, whatever their stamps say: a fixed place soon holds only what has been verified. */
  let seed = 0x2545f491;
  function probe(t, n) {
    const p = inOld(t);
    if (p >= 0) { st.probes += n; checkOld(t, p, n, true); return; }
    const words = t.words;
    const mask = words.length - 1;
    let at;
    if (cursorMode === 'rand') { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; at = seed & mask; }
    else at = t.at & mask;
    // a table being filled by a copy is sparse above the copy's frontier: do not scan it for long
    for (let passed = 0, limit = cursorMode === 'rand' ? mask + 1 : 64 * n; n > 0 && passed < limit; passed++) {
      const w = words[at];
      if (w === 0) { at = (at + 1) & mask; continue; }
      n--;
      st.probes++;
      if (t.refs[at].deref() === undefined) {
        removeAt(t, at);
        st.removed++;
        record(1);
        if ((w & STAMP) === stamp) { // died in THIS epoch: there has been a collection
          epoch++;
          stamp = ((epoch - 1) % STAMP) + 1;
          n = Math.max(n, BURST);
        }
      } else {
        words[at] = (w & ~STAMP) | stamp;
        record(0);
        at = (at + 1) & mask;
      }
    }
    if (cursorMode !== 'rand') t.at = at;
  }
  /** 'follow': the cursor's slot in the OLD array, or -1 if the copy has passed it (or nothing is being copied). */
  function inOld(t) {
    if (cursorMode !== 'follow' || t.oldWords === null) return -1;
    const p = t.bits >= t.oldBits ? t.at >> (t.bits - t.oldBits) : t.at << (t.oldBits - t.bits);
    return p >= t.cursor && p < t.oldWords.length ? p : -1;
  }
  /** Check up to `n` entries of the old array from slot p on, stamp-blind or not; the dead are blanked. Moves the cursor. */
  function checkOld(t, p, n, blind) {
    const oldWords = t.oldWords;
    const end = oldWords.length;
    let slots = 64 * n;
    while (n > 0 && slots-- > 0 && p < end) {
      const w = oldWords[p];
      const ref = t.oldRefs[p];
      if (w !== 0 && ref !== undefined && (blind || (w & STAMP) !== stamp)) {
        n--;
        if (ref.deref() === undefined) {
          t.oldRefs[p] = undefined;
          st.removed++;
          record(1);
          if ((w & STAMP) === stamp) { epoch++; stamp = ((epoch - 1) % STAMP) + 1; if (blind) n = Math.max(n, BURST); }
        } else {
          oldWords[p] = (w & ~STAMP) | stamp;
          st.checkedLive++;
          record(0);
        }
      }
      p++;
      if (t.sweepLeft > 0) t.sweepLeft -= t.bits >= t.oldBits ? 1 << (t.bits - t.oldBits) : 1;
    }
    t.at = (t.bits >= t.oldBits ? p << (t.bits - t.oldBits) : p >> (t.oldBits - t.bits)) & (t.words.length - 1);
  }
  function beginCopy(t, verify) {
    const size = t.words.length;
    const arriving = Math.max(t.used / (verify ? 2 : 4), size / SLOTS) + 16;
    let bits = MIN_BITS;
    if (verify) { while ((1 << bits) * 0.8 < t.used + arriving) bits++; bits = Math.max(bits, t.bits); }
    else while ((1 << bits) * 0.45 < t.used + arriving) bits++;
    if (bits === t.bits && !verify) return;
    t.oldBits = t.bits; t.oldWords = t.words; t.oldRefs = t.refs; t.cursor = 0; t.verify = verify; t.sweepLeft = 0;
    if (cursorMode === 'restart') { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; t.at = seed & ((1 << bits) - 1); }
    else if (cursorMode === 'scaled' || cursorMode === 'follow' || cursorMode === 'pause') t.at = bits >= t.bits ? t.at << (bits - t.bits) : t.at >> (t.bits - bits);
    else t.at = 0;
    t.bits = bits; t.words = new Int32Array(1 << bits); t.refs = new Array(1 << bits).fill(undefined); t.used = 0;
    st.copies++;
  }
  function copy(t) {
    const oldWords = t.oldWords;
    const end = oldWords.length;
    let c = t.cursor;
    let entries = 4;
    let slots = SLOTS;
    while (entries > 0 && slots-- > 0 && c < end) {
      const w = oldWords[c];
      if (w !== 0 && t.oldRefs[c] !== undefined) {
        const ref = t.oldRefs[c];
        if (!t.verify || (w & STAMP) === stamp) { place(t, w, ref); entries--; }
        else if (ref.deref() !== undefined) { place(t, (w & ~STAMP) | stamp, ref); entries -= 2; st.checkedLive++; record(0); }
        else { st.removed++; record(1); }
      }
      c++;
    }
    t.cursor = c;
    if (c < end) return;
    t.oldWords = null; t.oldRefs = null;
    if (t.used < t.words.length >> 3 && t.bits > MIN_BITS) beginCopy(t, false);
  }
  function sweep(t) {
    const p = inOld(t);
    if (p >= 0) { checkOld(t, p, LIVE, false); return; }
    const words = t.words;
    const mask = words.length - 1;
    let at = t.at & mask;
    let left = t.sweepLeft;
    let live = LIVE;
    for (let slots = SLOTS; slots > 0 && live > 0 && left > 0; slots--) {
      const w = words[at];
      if (w !== 0 && (w & STAMP) !== stamp) {
        if (t.refs[at].deref() === undefined) { removeAt(t, at); st.removed++; record(1); continue; }
        words[at] = (w & ~STAMP) | stamp;
        st.checkedLive++;
        record(0);
        live--;
      } else if (w !== 0) st.skipped++;
      at = (at + 1) & mask;
      left--;
    }
    t.at = at;
    t.sweepLeft = left;
    if (left <= 0 && t.used < words.length >> 3 && t.bits > MIN_BITS) beginCopy(t, false);
  }
  return {
    lookup(hash, predicate) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = shards[m >>> 26];
      if (t === undefined) return undefined;
      const tag = m << 6;
      let words = t.words;
      let mask = words.length - 1;
      let i = tag >>> (32 - t.bits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if ((w & ~STAMP) !== tag) continue;
        const v = t.refs[i].deref();
        if (v !== undefined && predicate(v)) { if ((w & STAMP) !== stamp) words[i] = tag | stamp; return v; }
      }
      words = t.oldWords;
      if (words === null) return undefined;
      mask = words.length - 1;
      i = tag >>> (32 - t.oldBits);
      for (let w = words[i]; w !== 0; i = (i + 1) & mask, w = words[i]) {
        if ((w & ~STAMP) !== tag || t.oldRefs[i] === undefined) continue;
        const v = t.oldRefs[i].deref();
        if (v !== undefined && predicate(v)) { if ((w & STAMP) !== stamp) words[i] = tag | stamp; return v; }
      }
      return undefined;
    },
    register(value, hash) {
      const m = Math.imul(hash, 0x9e3779b1);
      const t = (shards[m >>> 26] ??= newShard());
      if ((++tick & (PROBE_EVERY - 1)) === 0 && t.used > 0 && !(cursorMode === 'pause' && t.oldWords !== null)) probe(t, 1);
      if (t.oldWords !== null) {
        copy(t);
        if (cursorMode === 'follow' && t.oldWords !== null && !t.verify) {
          if (t.answered !== epoch) { t.answered = epoch; if (dead16 >= theta * WINDOW) { t.sweepLeft = t.words.length; st.laps++; } }
          if (t.sweepLeft > 0) sweep(t);
        }
      } else {
        const full = t.used >= t.words.length >> 1;
        if (t.answered !== epoch && (full || t.used > 32)) {
          t.answered = epoch; // a shard answers a detected collection once
          if (dead16 >= theta * WINDOW) { t.sweepLeft = t.words.length; st.laps++; }
        }
        if (full) beginCopy(t, cursorMode === 'pause' ? false : t.sweepLeft > 0);
        else if (t.sweepLeft > 0) sweep(t);
      }
      place(t, (m << 6) | stamp, new WeakRef(value));
      return value;
    },
    stats() {
      let stored = 0;
      let slots = 0;
      for (const t of shards) {
        if (t === undefined) continue;
        stored += t.used;
        slots += t.words.length;
        if (t.oldWords !== null) { slots += t.oldWords.length; for (let c = t.cursor; c < t.oldWords.length; c++) if (t.oldWords[c] !== 0 && t.oldRefs[c] !== undefined) stored++; }
      }
      return { stored, slots, epochs: epoch - 1, cycles: st.copies, forced: st.laps, byHit: 0, skipped: st.skipped, derefLive: st.checkedLive, derefDead: st.removed, probes: st.probes };
    },
  };
}

// --- child: one pool, one scenario --------------------------------------------

function fmix(k) {
  k = Math.imul(k ^ (k >>> 16), 0x85ebca6b);
  k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35);
  return (k ^ (k >>> 16)) | 0;
}

async function child(poolName, scenarioName) {
  globalThis.gc ??= () => globalThis.Bun.gc(true); // JavaScriptCore, under Bun: a synchronous full collection
  const sc = SCENARIOS[scenarioName];
  const yieldTask = () => new Promise((r) => setImmediate(r));
  let pool;
  let shippedStats = null;
  if (poolName === 'shipped' || poolName === 'fr') {
    const mod = await import(poolName === 'fr' ? './fr-pool.mjs' : '../../dist/intern-pool.js');
    pool = mod.createInternPool();
    shippedStats = () => mod._poolStats(pool);
  } else if (poolName.startsWith('chain')) {
    const opts = poolName.split(' ').slice(1);
    const c = opts.find((o) => o.startsWith('cap'));
    const g = opts.find((o) => o.startsWith('gain'));
    pool = makeChainPool(c ? Number(c.slice(3)) : 2, opts.includes('+reads'), g ? Number(g.slice(4)) : 4, opts.includes('presize'));
  } else if (poolName.startsWith('psweep')) {
    const g = poolName.split(' ').find((o) => o.startsWith('gate'));
    pool = makeProbeSweepPool(g ? Number(g.slice(4)) : 0.67, poolName.includes('restart') ? 'restart' : poolName.includes('scaled') ? 'scaled' : poolName.includes('follow') ? 'follow' : poolName.includes('pause') ? 'pause' : 'rand', Number(poolName.split(' ').find((o) => /^w\d+$/.test(o))?.slice(1) ?? 16));
  } else if (poolName.startsWith('gsweep')) {
    const g = poolName.split(' ').find((o) => o.startsWith('gate'));
    const l = poolName.split(' ').find((o) => o.startsWith('live'));
    pool = makeGatedSweepPool(g ? Number(g.slice(4)) : 0.5, l ? Number(l.slice(4)) : 2, !poolName.includes('noshrink'));
  } else if (poolName.startsWith('sweep')) {
    const c = poolName.split(' ').find((o) => o.startsWith('cap'));
    const g = poolName.split(' ').find((o) => o.startsWith('gain'));
    const b = poolName.split(' ').find((o) => /^b\d+$/.test(o));
    pool = makeSweepPool(c ? Number(c.slice(3)) : 2, g ? Number(g.slice(4)) : 4, b ? Number(b.slice(1)) : 1, poolName.includes('nodelete'));
  } else if (poolName === 'null') {
    // harness only: key, hash, the {k} object, the live-array store, the hit's random read
    pool = { lookup: () => undefined, register: (v) => v };
  } else if (poolName === 'wr') {
    // harness + one WeakRef per insert, retained in a ring the size of a typical index
    const ring = new Array(1 << 20).fill(undefined);
    let at = 0;
    pool = { lookup: () => undefined, register(v) { ring[at] = new WeakRef(v); at = (at + 1) & (ring.length - 1); return v; } };
  } else {
    const [, k, ...opts] = poolName.split(' ');
    const gate = opts.find((o) => o.startsWith('gate'));
    const b = opts.find((o) => /^b\d+$/.test(o));
    pool = makeSemiPool(Number(k), opts.includes('+hits'), gate ? Number(gate.slice(4)) : 0, b ? Number(b.slice(1)) : 1);
  }

  const ablation = poolName === 'null' || poolName === 'wr';
  let prof = null;
  if (process.env.PROF) {
    const { Session } = await import('node:inspector/promises');
    prof = new Session();
    prof.connect();
    await prof.post('Profiler.enable');
    await prof.post('Profiler.setSamplingInterval', { interval: 200 });
  }
  let nextKey = 1;
  let wanted = 0;
  const pred = (c) => c.k === wanted;
  const live = [];
  let rnd = 0x2545f491;
  const rand = () => {
    rnd ^= rnd << 13;
    rnd ^= rnd >>> 17;
    rnd ^= rnd << 5;
    return rnd >>> 0;
  };
  let junk = [];
  function insert(targetW) {
    if (sc.junk) { // unrelated garbage, as an application makes
      if ((nextKey & 7) === 0) junk.push(new Array(16).fill(nextKey));
      if (junk.length > 20_000) junk = [];
    }
    const k = nextKey++;
    const h = fmix(k);
    wanted = k;
    let v = pool.lookup(h, pred);
    if (v === undefined) v = pool.register({ k }, h);
    if (live.length < targetW) live.push(v);
    else live[rand() % live.length] = v; // the evicted member is the death
  }
  function hit() {
    const m = live[rand() % (HOT > 0 && HOT < live.length ? HOT : live.length)]; // HOT: hits go to the first HOT live slots
    wanted = m.k;
    const got = pool.lookup(fmix(m.k), pred);
    if (got !== m && !ablation) throw new Error('lost a live member');
  }

  // Prefill, untimed.
  for (let i = 0; i < sc.prefill; i++) {
    insert(sc.prefill);
    if (i % BATCH === BATCH - 1) await yieldTask();
  }
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await yieldTask();
    await yieldTask();
  }

  // the engine's own count of collections during the timed phase (Node only)
  const gcs = { major: 0, minor: 0 };
  if (typeof process !== 'undefined' && process.versions?.node && !globalThis.Bun) {
    const { PerformanceObserver, constants } = await import('node:perf_hooks');
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcs.major++;
        else if (e.detail.kind === constants.NODE_PERFORMANCE_GC_MINOR) gcs.minor++;
      }
    }).observe({ entryTypes: ['gc'] });
  }
  if (prof) await prof.post('Profiler.start');
  let opsMs = 0;
  let gcMs = 0;
  let turnMs = 0;
  let maxBatch = 0;
  let ops = 0;
  let sinceGc = 0;
  if (sc.burst) {
    const b = sc.burst;
    for (let round = 0; round < b.rounds; round++) {
      for (let i = 0; i < b.churn; i++) insert(b.w);
      const t1 = performance.now();
      for (let k = 0; k < 3; k++) {
        globalThis.gc();
        for (let i = 0; i < 100; i++) await yieldTask();
      }
      globalThis.gc();
      turnMs += performance.now() - t1;
      const t0 = performance.now();
      for (let i = 0; i < b.timed; i++) insert(b.w);
      const dt = performance.now() - t0;
      opsMs += dt;
      if (dt > maxBatch) maxBatch = dt;
      ops += b.timed;
    }
  }
  for (const ph of sc.phases ?? []) {
    if (live.length > ph.w) live.length = ph.w; // mass death
    for (let done = 0; done < ph.inserts; done += BATCH) {
      const t0 = performance.now();
      for (let i = 0; i < BATCH; i++) {
        insert(ph.w);
        for (let q = 0; q < ph.hits; q++) hit();
      }
      const t1 = performance.now();
      opsMs += t1 - t0;
      if (t1 - t0 > maxBatch) maxBatch = t1 - t0;
      ops += BATCH * (1 + ph.hits);
      sinceGc += BATCH;
      await yieldTask();
      const t2 = performance.now();
      turnMs += t2 - t1;
      if (sinceGc >= sc.gcEvery) {
        sinceGc = 0;
        globalThis.gc();
        gcMs += performance.now() - t2;
      }
    }
  }
  if (prof) {
    const { profile } = await prof.post('Profiler.stop');
    const fsm = await import('node:fs');
    fsm.writeFileSync(process.env.PROF, JSON.stringify(profile));
  }
  const before = pool.stats ? pool.stats() : ablation ? { stored: 0 } : shippedStats();
  for (let i = 0; i < 3; i++) {
    globalThis.gc();
    await yieldTask();
    await yieldTask();
  }
  const mu = process.memoryUsage();
  const out = {
    nsPerOp: (opsMs * 1e6) / ops,
    gcMs,
    turnMs,
    maxBatch,
    stored: before.stored ?? before.slots,
    memMB: (mu.heapUsed + mu.arrayBuffers) / 2 ** 20,
    live: live.length,
    gcs,
    extra: pool.stats ? before : null,
  };
  console.log(JSON.stringify(out));
}

// --- parent --------------------------------------------------------------------

const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

if (process.argv[2] === 'child') {
  await child(process.argv[3], process.argv[4]);
} else {
  const rounds = Number(process.argv[2] ?? 3);
  const self = fileURLToPath(import.meta.url);
  console.log(`${process.env.RUNTIME ?? `node ${process.version}`}, ${rounds} rounds, median (min–max for ns/op)\n`);
  const only = process.env.ONLY?.split(',');
  for (const scenario of Object.keys(SCENARIOS)) {
    if (only && !only.some((o) => scenario.includes(o))) continue;
    console.log(`## ${scenario}`);
    console.log('pool            ns/op (min–max)      gc ms   turns ms   max batch   stored    mem MB   | migrated: by hit / no deref / →dead / →live');
    for (const pool of POOLS) {
      const rs = [];
      for (let r = 0; r < rounds; r++) {
        const runtime = process.env.RUNTIME;
        const p = spawnSync(runtime ?? process.execPath, [...(runtime ? [] : ['--expose-gc', '--max-old-space-size=8192']), self, 'child', pool, scenario], { encoding: 'utf8', timeout: 240_000 });
        if (p.status !== 0) {
          console.log(`${pool}: FAILED ${p.stderr.split('\n')[0]}`);
          continue;
        }
        rs.push(JSON.parse(p.stdout.trim().split('\n').pop()));
      }
      if (rs.length === 0) continue;
      const ns = rs.map((r) => r.nsPerOp);
      let extra = '';
      const e = rs[0].extra;
      if (e) {
        const t = e.byHit + e.skipped + e.derefDead + e.derefLive || 1;
        const pc = (x) => `${Math.round((100 * x) / t)}%`;
        extra = `| ${pc(e.byHit)} / ${pc(e.skipped)} / ${pc(e.derefDead)} / ${pc(e.derefLive)}   cycles ${e.cycles}, forced ${e.forced}, epochs ${e.epochs}`;
      }
      console.log(
        `${pool.padEnd(19)} ${med(ns).toFixed(0).padStart(5)} (${Math.min(...ns).toFixed(0)}–${Math.max(...ns).toFixed(0)})`.padEnd(36) +
          `${med(rs.map((r) => r.gcMs)).toFixed(0).padStart(6)} ${med(rs.map((r) => r.turnMs)).toFixed(0).padStart(9)} ${med(rs.map((r) => r.maxBatch)).toFixed(1).padStart(10)} ${String(med(rs.map((r) => r.stored))).padStart(9)} ${med(rs.map((r) => r.memMB)).toFixed(0).padStart(8)}   ${extra}`,
      );
    }
    console.log('');
  }
}
