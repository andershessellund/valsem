// ---------------------------------------------------------------------------
// The timing helpers, with no Node import in sight: this module (and any suite
// built on it alone) also runs in an engine shell, which has no `process`, no
// `node:` modules and no event loop. lib.mjs re-exports everything here.
// ---------------------------------------------------------------------------

/** Nanoseconds, from the best clock the host has. */
const now =
  typeof globalThis.process?.hrtime?.bigint === 'function'
    ? () => Number(globalThis.process.hrtime.bigint())
    : () => performance.now() * 1e6;

/** Nanoseconds per call of `fn(i)` over `iterations`, after a warm-up. */
export function time(fn, iterations, warmup = Math.min(2000, Math.max(3, iterations / 5))) {
  for (let i = 0; i < warmup; i++) fn(i);
  const t0 = now();
  for (let i = 0; i < iterations; i++) fn(i);
  return (now() - t0) / iterations;
}

/**
 * Nanoseconds per call under the honest regime for update libraries: the
 * result is retained (a ring of 50), and one call runs per macrotask so
 * WeakRef kept-objects are released between calls. The yield cost is
 * measured and subtracted.
 */
export async function timeHeld(fn, iterations) {
  const yieldTask = () => new Promise((r) => setImmediate(r));
  const ring = new Array(50);
  for (let i = 0; i < Math.min(200, iterations); i++) {
    ring[i % 50] = fn(i);
    await yieldTask();
  }
  const t0 = now();
  for (let i = 0; i < iterations; i++) {
    ring[i % 50] = fn(i);
    await yieldTask();
  }
  const total = (now() - t0) / iterations;
  const y0 = now();
  for (let i = 0; i < iterations; i++) await yieldTask();
  const yieldCost = (now() - y0) / iterations;
  return Math.max(0, total - yieldCost);
}

/** A row: `values` maps column label → number (in the suite's unit) or null. */
export function row(name, values, note) {
  return note === undefined ? { name, values } : { name, values, note };
}

/** Deterministic shuffle (LCG), so "independently built" means a different insertion order. */
export function shuffled(arr, seed = 1) {
  const out = arr.slice();
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function assertEq(a, b, what = '') {
  if (a !== b) throw new Error(`result mismatch ${what}: ${String(a)} vs ${String(b)}`);
}
