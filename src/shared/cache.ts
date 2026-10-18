// Caché en memoria con TTL y "single-flight": si N peticiones piden la misma
// clave mientras se está cargando, todas esperan UNA sola carga (evita la
// estampida contra la BD cuando varios dashboards consultan a la vez).
//
// Es por proceso: con varias instancias cada una tiene la suya, lo que es
// aceptable porque solo se usa para datos con TTL corto o que cambian poco.

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Vida de cada entrada, en milisegundos. */
  ttlMs: number;
  /** Tope de entradas; al superarlo se descarta la más antigua. */
  maxEntries?: number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor({ ttlMs, maxEntries = 500 }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /** Devuelve el valor vigente o ejecuta `load` (una sola vez por clave a la vez). */
  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key?: K): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  private set(key: K, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
