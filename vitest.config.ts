import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        // The intern-pool suite exercises real GC reclamation (WeakRef death
        // reported through FinalizationRegistry, then the deferred drain);
        // those tests skip themselves when globalThis.gc is unavailable.
        execArgv: ['--expose-gc'],
      },
    },
  },
});
