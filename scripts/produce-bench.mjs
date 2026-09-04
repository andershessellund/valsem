// ---------------------------------------------------------------------------
// produce-bench — valsem produce vs immer vs mutative vs hand-rolled spread.
//
// Shapes:
//   big-array   { arr: [N items] }, modify one item's field   (the Mutative arena)
//   big-array (held, macrotask) — same shape under the honest regime: results
//               retained, one produce per task (see scripts/big-array-bench.mjs
//               for clean per-process runs of this arena)
//   wide-record 1000-key record, modify one value
//   value-map   ValueMap(N) via DraftMap.set (valsem) vs Map drafts (immer/mutative)
//   value-list  ValueList(N) set+push (valsem) vs array (immer/mutative)
//   small-churn 3-field record counter update (per-op overhead floor)
//   recurrent   states cycle through 10 configurations (valsem's dedup arena)
//
// Every iteration produces a NOVEL state (value = iteration counter) except
// `recurrent`. Libraries run at their SHIPPED defaults (immer auto-freezes,
// mutative does not); an immer-noFreeze variant is included for fairness.
//
// Run: pnpm build && node scripts/produce-bench.mjs [N-items] [iterations]
// ---------------------------------------------------------------------------

import { produce as valsemProduce, produceWithPatches } from '../dist/produce.js';
import { intern } from '../dist/intern.js';
import { ValueMap } from '../dist/value-map.js';
import { ValueList } from '../dist/value-list.js';
import { produce as immerProduce, setAutoFreeze, enableMapSet } from 'immer';
import { create as mutativeCreate } from 'mutative';

enableMapSet();

const N = Number(process.argv[2] ?? 10_000);
const ITER = Number(process.argv[3] ?? 2_000);

function bench(name, fn, iterations = ITER) {
  // warmup
  for (let i = 0; i < Math.min(200, iterations); i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const ns = Number(process.hrtime.bigint() - t0);
  const opsPerSec = (iterations / (ns / 1e9)).toFixed(0);
  const usPerOp = (ns / iterations / 1000).toFixed(1);
  console.log(`  ${name.padEnd(26)} ${String(opsPerSec).padStart(10)} ops/s   ${String(usPerOp).padStart(8)} µs/op`);
  return ns;
}

function makeItems(n) {
  const items = new Array(n);
  for (let i = 0; i < n; i++) items[i] = { id: i, label: `item-${i}`, value: 0 };
  return items;
}

// --- big-array -------------------------------------------------------------
{
  console.log(`\nbig-array — { arr: [${N} items] }, modify one item's field`);
  const mid = N >> 1;

  const valsemBase = intern({ arr: makeItems(N) });
  bench('valsem produce', (i) => {
    valsemProduce(valsemBase, (d) => {
      d.arr[mid].value = i;
    });
  });
  bench('valsem withPatches', (i) => {
    produceWithPatches(valsemBase, (d) => {
      d.arr[mid].value = i;
    });
  });

  setAutoFreeze(true);
  const immerBase = immerProduce({ arr: makeItems(N) }, () => {});
  bench('immer (autofreeze on)', (i) => {
    immerProduce(immerBase, (d) => {
      d.arr[mid].value = i;
    });
  });
  setAutoFreeze(false);
  const immerBase2 = immerProduce({ arr: makeItems(N) }, () => {});
  bench('immer (autofreeze off)', (i) => {
    immerProduce(immerBase2, (d) => {
      d.arr[mid].value = i;
    });
  });
  setAutoFreeze(true);

  const mutativeBase = { arr: makeItems(N) };
  bench('mutative', (i) => {
    mutativeCreate(mutativeBase, (d) => {
      d.arr[mid].value = i;
    });
  });

  const plainBase = { arr: makeItems(N) };
  bench('hand-rolled spread', (i) => {
    const arr = plainBase.arr.slice();
    arr[mid] = { ...arr[mid], value: i };
    return { ...plainBase, arr };
  });
}

// --- big-array, held + macrotask (the arena of record, in-suite) ------------
{
  console.log(
    `\nbig-array (held, macrotask per op) — results retained in a 50-ring, one produce per task`,
  );
  const yieldTask = () => new Promise((r) => setImmediate(r));
  async function benchTask(name, fn, iterations = ITER) {
    const ring = new Array(50);
    for (let i = 0; i < Math.min(200, iterations); i++) {
      ring[i % 50] = fn(i);
      await yieldTask();
    }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      ring[i % 50] = fn(i);
      await yieldTask();
    }
    const total = Number(process.hrtime.bigint() - t0) / iterations / 1000;
    const y0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) await yieldTask();
    const yieldCost = Number(process.hrtime.bigint() - y0) / iterations / 1000;
    const per = total - yieldCost;
    const opsPerSec = (1e6 / per).toFixed(0);
    console.log(
      `  ${name.padEnd(26)} ${String(opsPerSec).padStart(10)} ops/s   ${per.toFixed(1).padStart(8)} µs/op  (yield ${yieldCost.toFixed(1)} µs subtracted)`,
    );
  }

  const mid = N >> 1;
  // Successor values offset by 1e6: the pool is process-global, so reusing the
  // sync arena's values would transition-memo/pool-hit instead of producing.
  const valsemBase = intern({ arr: makeItems(N) });
  await benchTask('valsem produce', (i) =>
    valsemProduce(valsemBase, (d) => {
      d.arr[mid].value = i + 1_000_000;
    }),
  );

  setAutoFreeze(false);
  const immerBase = immerProduce({ arr: makeItems(N) }, () => {});
  await benchTask('immer (no freeze)', (i) =>
    immerProduce(immerBase, (d) => {
      d.arr[mid].value = i + 1_000_000;
    }),
  );
  setAutoFreeze(true);

  const mutativeBase = { arr: makeItems(N) };
  await benchTask('mutative', (i) =>
    mutativeCreate(mutativeBase, (d) => {
      d.arr[mid].value = i + 1_000_000;
    }),
  );
}

// --- wide-record -----------------------------------------------------------
{
  console.log('\nwide-record — 1000-key record, modify one value');
  const rec = {};
  for (let i = 0; i < 1000; i++) rec[`key${i}`] = i;

  const valsemBase = intern(rec);
  bench('valsem produce', (i) => {
    valsemProduce(valsemBase, (d) => {
      d.key500 = i;
    });
  });

  const immerBase = immerProduce({ ...rec }, () => {});
  bench('immer', (i) => {
    immerProduce(immerBase, (d) => {
      d.key500 = i;
    });
  });

  const mutativeBase = { ...rec };
  bench('mutative', (i) => {
    mutativeCreate(mutativeBase, (d) => {
      d.key500 = i;
    });
  });

  bench('hand-rolled spread', (i) => ({ ...rec, key500: i }));
}

// --- value-map -------------------------------------------------------------
{
  console.log(`\nvalue-map — ${N}-entry map, set one key`);
  const entries = [];
  for (let i = 0; i < N; i++) entries.push([`k${i}`, i]);

  const valsemBase = ValueMap.from(entries);
  bench('valsem DraftMap', (i) => {
    valsemProduce(valsemBase, (d) => {
      d.set('k5', i);
    });
  });
  bench('valsem ValueMap.set', (i) => valsemBase.set('k5', i));

  const immerBase = immerProduce(new Map(entries), () => {});
  bench('immer Map draft', (i) => {
    immerProduce(immerBase, (d) => {
      d.set('k5', i);
    });
  });

  const mutativeBase = new Map(entries);
  bench('mutative Map draft', (i) => {
    mutativeCreate(mutativeBase, (d) => {
      d.set('k5', i);
    });
  });
}

// --- value-list ------------------------------------------------------------
{
  console.log(`\nvalue-list — ${N}-element list, set one + push one`);
  const nums = Array.from({ length: N }, (_, i) => i);
  const mid = N >> 1;

  const valsemBase = ValueList.from(nums);
  bench('valsem DraftList', (i) => {
    valsemProduce(valsemBase, (d) => {
      d.set(mid, i);
      d.push(i);
    });
  });
  bench('valsem ValueList ops', (i) => valsemBase.set(mid, i).push(i));

  setAutoFreeze(false); // array autofreeze dominates otherwise
  const immerBase = nums.slice();
  bench('immer array (no freeze)', (i) => {
    immerProduce(immerBase, (d) => {
      d[mid] = i;
      d.push(i);
    });
  });
  setAutoFreeze(true);

  const mutativeBase = nums.slice();
  bench('mutative array', (i) => {
    mutativeCreate(mutativeBase, (d) => {
      d[mid] = i;
      d.push(i);
    });
  });
}

// --- small-churn -----------------------------------------------------------
{
  console.log('\nsmall-churn — { x, y, z }, one field update (per-op floor)');
  const valsemBase = intern({ x: 0, y: 0, z: 0 });
  bench('valsem produce', (i) => {
    valsemProduce(valsemBase, (d) => {
      d.x = i;
    });
  }, ITER * 10);

  const immerBase = immerProduce({ x: 0, y: 0, z: 0 }, () => {});
  bench('immer', (i) => {
    immerProduce(immerBase, (d) => {
      d.x = i;
    });
  }, ITER * 10);

  const mutativeBase = { x: 0, y: 0, z: 0 };
  bench('mutative', (i) => {
    mutativeCreate(mutativeBase, (d) => {
      d.x = i;
    });
  }, ITER * 10);

  bench('hand-rolled spread', (i) => ({ x: i, y: 0, z: 0 }), ITER * 10);
}

// --- recurrent -------------------------------------------------------------
{
  console.log(
    `\nrecurrent — big-array arena, 10 configurations cycling, results HELD (as a real app holds recurring states)`,
  );
  const mid = N >> 1;
  const valsemBase = intern({ arr: makeItems(N) });
  const heldV = new Array(10);
  bench('valsem produce', (i) => {
    heldV[i % 10] = valsemProduce(valsemBase, (d) => {
      d.arr[mid].value = i % 10;
    });
  });

  setAutoFreeze(true);
  const immerBase = immerProduce({ arr: makeItems(N) }, () => {});
  const heldI = new Array(10);
  bench('immer', (i) => {
    heldI[i % 10] = immerProduce(immerBase, (d) => {
      d.arr[mid].value = i % 10;
    });
  });

  const mutativeBase = { arr: makeItems(N) };
  const heldM = new Array(10);
  bench('mutative', (i) => {
    heldM[i % 10] = mutativeCreate(mutativeBase, (d) => {
      d.arr[mid].value = i % 10;
    });
  });
  console.log('  (valsem returns 10 pooled instances — equality afterwards is ===)');
}
