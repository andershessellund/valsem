import { defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/reporters';

// Four suites SELF-SKIP when the runtime lacks what they need (the two flags
// below, iterator helpers), and a skipped test reads as green. That has
// happened: vitest 4 moved `execArgv` out of `poolOptions.forks`, the flags
// stopped arriving, and the run stayed green with twelve tests skipped. CI
// provides everything every suite needs, so there a skip is a failure. Not
// locally: `-t` and `.only` skip what they filter out, and that is the point
// of them.
const noSkipsInCI: Reporter = {
  onTestRunEnd(testModules) {
    if (!process.env.CI) return;
    const skipped: string[] = [];
    for (const module of testModules) {
      for (const test of module.children.allTests('skipped')) skipped.push(`${module.relativeModuleId} > ${test.fullName}`);
    }
    if (skipped.length === 0) return;
    console.error(`\n${skipped.length} skipped in CI, where every suite must run:\n  ${skipped.join('\n  ')}\n`);
    process.exitCode = 1;
  },
};

export default defineConfig({
  test: {
    // The intern-pool suite exercises real GC reclamation (WeakRef death
    // reported through FinalizationRegistry, then the deferred drain);
    // those tests skip themselves when globalThis.gc is unavailable.
    // --allow-natives-syntax lets fast-properties.test.ts ask V8 whether a
    // canonical record is in fast (not dictionary) mode.
    execArgv: ['--expose-gc', '--allow-natives-syntax'],
    reporters: ['default', noSkipsInCI],
    // Every file gets its own process, and six suites depend on it: they set
    // once-per-process state before anything else loads (configureHasher in
    // hamt-collisions and collisions; skip-checks; skip-freezing) or reload
    // the module graph (duplicate-install, temporal-missing). vitest's
    // summary suggests `isolate: false` for speed. Do not take it.
    isolate: true,
    coverage: {
      provider: 'v8',
      // `pnpm test:coverage`: the table, with the uncovered lines, and no files.
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-helpers.ts'],
    },
  },
});
