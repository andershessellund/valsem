import { defineConfig, configDefaults } from 'vitest/config';

// The ordinary suite under a polluted Array.prototype — see
// src/pollution.test-helpers.ts. Run with `pnpm test:polluted`; CI runs it on
// every change.
export default defineConfig({
  test: {
    // Same worker flags as vitest.config.ts: the GC and fast-properties suites
    // self-skip without them.
    execArgv: ['--expose-gc', '--allow-natives-syntax'],
    setupFiles: ['./src/pollution.test-helpers.ts'],
    exclude: [
      ...configDefaults.exclude,
      // fast-check itself cannot run here: its BigInt arbitraries read holes
      // in their own arrays and fail with "Cannot mix BigInt and other types".
      // These four use them. A new file failing with THAT error belongs here;
      // any other failure under this config is a hole read in valsem.
      'src/index-arguments.test.ts',
      'src/property-laws.test.ts',
      'src/property-produce.test.ts',
      'src/property-values.test.ts',
    ],
  },
});
