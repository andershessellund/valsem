// valsem/temporal without a Temporal global: the import must fail loudly.
// And with a Temporal that is not all there (a partial polyfill): it takes
// the kinds it finds, and refuses one it cannot give value semantics to.
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

describe('valsem/temporal — a Temporal that is not all there', () => {
  const g = globalThis as { Temporal?: unknown };

  it('registers the kinds the global has and passes over the ones it lacks', async () => {
    const { Temporal: real } = await import('./temporal.test-helpers.js');
    const saved = g.Temporal;
    g.Temporal = { PlainDate: real.PlainDate, PlainTime: 'not a constructor', Instant: class NoFrom {} };
    try {
      vi.resetModules();
      await import('./temporal.js');
      const { deepEqual, deepHash } = await import('./index.js');
      expect(deepEqual(real.PlainDate.from('2026-08-31'), real.PlainDate.from('2026-08-31'))).toBe(true);
      expect(() => deepHash(real.PlainTime.from('12:30'))).toThrow(TypeError); // not registered: not a value
    } finally {
      g.Temporal = saved;
    }
  });

  it('a kind without equals() is not a Temporal it knows how to compare, and it says which', async () => {
    const saved = g.Temporal;
    g.Temporal = { PlainDate: class PlainDate { static from(): void {} } };
    try {
      vi.resetModules();
      await expect(import('./temporal.js')).rejects.toThrow(/Temporal\.PlainDate\.prototype\.equals is missing/);
    } finally {
      g.Temporal = saved;
    }
  });
});
