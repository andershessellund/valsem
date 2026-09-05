// valsem/temporal without a Temporal global: the import must fail loudly.
import { describe, it, expect, vi } from 'vitest';

describe('valsem/temporal — no Temporal global', () => {
  it('throws a teaching error at import', async () => {
    const g = globalThis as { Temporal?: unknown };
    const saved = g.Temporal;
    delete g.Temporal;
    try {
      vi.resetModules();
      await expect(import('./temporal.js')).rejects.toThrow(/no Temporal global found/);
    } finally {
      g.Temporal = saved;
    }
  });
});
