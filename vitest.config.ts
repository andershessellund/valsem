import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The intern-pool suite exercises real GC reclamation (WeakRef death
    // reported through FinalizationRegistry, then the deferred drain);
    // those tests skip themselves when globalThis.gc is unavailable.
    // --allow-natives-syntax lets fast-properties.test.ts ask V8 whether a
    // canonical record is in fast (not dictionary) mode.
    //
    // Both suites SELF-SKIP without their flag, so a config that stops
    // delivering the flags turns them off silently: vitest 4 moved this
    // option out of `poolOptions.forks`, and the run stayed green with twelve
    // tests skipped. After touching this, check the summary says 0 skipped.
    execArgv: ['--expose-gc', '--allow-natives-syntax'],
  },
});
