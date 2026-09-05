import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        // The intern-pool suite exercises real GC reclamation (WeakRef death
        // reported through FinalizationRegistry, then the deferred drain);
        // those tests skip themselves when globalThis.gc is unavailable.
        // --allow-natives-syntax lets fast-properties.test.ts ask V8 whether a
        // canonical record is in fast (not dictionary) mode.
        execArgv: ['--expose-gc', '--allow-natives-syntax'],
      },
    },
  },
});
