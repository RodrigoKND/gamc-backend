import { describe, it, expect, vi } from 'vitest';
import { TtlCache } from '../cache.js';

describe('TtlCache', () => {
  it('agrupa cargas simultáneas de la misma clave en una sola', async () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000 });
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 7;
    });

    const results = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);

    expect(results).toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sirve de caché hasta que vence el TTL', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>({ ttlMs: 1000 });
    const load = vi.fn(async () => 1);

    await cache.getOrLoad('k', load);
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('no cachea los errores', async () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000 });
    await expect(cache.getOrLoad('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(cache.getOrLoad('k', async () => 5)).resolves.toBe(5);
  });

  it('respeta maxEntries descartando la más antigua', async () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxEntries: 2 });
    const load = vi.fn(async () => 1);
    await cache.getOrLoad('a', load);
    await cache.getOrLoad('b', load);
    await cache.getOrLoad('c', load);
    await cache.getOrLoad('a', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
