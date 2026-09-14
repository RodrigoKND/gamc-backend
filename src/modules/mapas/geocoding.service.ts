import { logger } from '@infra/logger';

// Geocodificación inversa (lat/lng → dirección legible) vía Nominatim
// (OpenStreetMap). Política de uso de Nominatim: máx. 1 request/segundo,
// User-Agent identificable con contacto, no debe llamarse desde el navegador
// — por eso vive acá y no en el frontend. https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'GAMC-Seguridad-Ciudadana/1.0 (contacto: soporte@gamc-cochabamba.bo)';
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días — las calles no se mueven.
const REQUEST_TIMEOUT_MS = 5000;

interface CacheEntry {
  direccion: string | null;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const enVuelo = new Set<string>();
let lastRequestAt = 0;

// Redondear a 4 decimales (~11m de resolución) agrupa puntos de una misma
// cuadra bajo la misma entrada de caché — reduce drásticamente las llamadas
// salientes para un guardia que se mueve dentro de la misma calle.
function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function extraerDireccion(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const addr = (json as Record<string, unknown>).address as Record<string, unknown> | undefined;
  const displayName = (json as Record<string, unknown>).display_name as string | undefined;
  if (addr) {
    const via = (addr.road ?? addr.pedestrian ?? addr.footway) as string | undefined;
    const numero = addr.house_number as string | undefined;
    const zona = (addr.suburb ?? addr.neighbourhood ?? addr.city_district) as string | undefined;
    if (via) {
      return [numero ? `${via} ${numero}` : via, zona].filter(Boolean).join(', ');
    }
  }
  return displayName ?? null;
}

// Lectura SÍNCRONA para usar en el hot path de un endpoint (ej. el listado de
// ubicaciones del mapa, que se llama en cada poll/refresh en vivo — nunca
// debe esperar 1.1s por coordenada). Si hay caché, la devuelve de inmediato;
// si no, dispara la resolución real en segundo plano (respetando el
// throttle de Nominatim) para que quede lista en el próximo poll, y
// devuelve `undefined` por ahora ("todavía no se sabe", distinto de `null`
// = "se intentó y Nominatim no devolvió nada").
export function peekAddress(lat: number, lng: number): string | null | undefined {
  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.direccion;
  }
  if (!enVuelo.has(key)) {
    enVuelo.add(key);
    void reverseGeocode(lat, lng).finally(() => enVuelo.delete(key));
  }
  return undefined;
}

// Traduce lat/lng a una dirección legible ("Av. Heroínas 123, Cercado").
// Devuelve null si no se pudo resolver (nunca lanza) — el llamador debe
// tratar null como "dirección no disponible", no como error fatal. Uso
// directo (await) solo para casos que SÍ pueden esperar (ej. un endpoint
// bajo demanda); para el hot path del mapa usar `peekAddress`.
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.direccion;
  }

  try {
    await throttle();
    const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
    const json = await res.json();
    const direccion = extraerDireccion(json);
    cache.set(key, { direccion, cachedAt: Date.now() });
    return direccion;
  } catch (error) {
    logger.warn({ error, lat, lng }, 'reverseGeocode: no se pudo resolver la dirección');
    // Cachea el fallo brevemente (no con el TTL completo) para no martillar
    // Nominatim con coordenadas que fallan de forma persistente.
    cache.set(key, { direccion: null, cachedAt: Date.now() - CACHE_TTL_MS + 5 * 60 * 1000 });
    return null;
  }
}
