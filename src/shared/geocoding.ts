// Geocodificación inversa (lat/lng → dirección legible) para hechos y
// ubicaciones de guardias — antes solo se mostraban las coordenadas crudas.
// Usa Nominatim (OpenStreetMap), gratis y sin llave — coherente con que el
// mapa del frontend ya usa teselas OSM (ver mapConfig, NEXT_PUBLIC_MAP_*).
//
// Nominatim exige un User-Agent identificable y máximo ~1 req/seg desde su
// instancia pública (https://operations.osmfoundation.org/policies/nominatim/):
// por eso el throttle y el cache acá — sin esto, listar varios guardias en
// el mapa dispararía un burst de llamadas y Nominatim empezaría a devolver
// 403. El cache está pensado para posiciones (que se repiten mucho en un
// radio chico mientras el guardia patrulla), no hace falta nada más fino
// para el volumen de guardias de este proyecto.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'GAMC-SeguridadCiudadana/1.0 (contacto: sistemas@cochabamba.bo)';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — suficiente para un turno de patrullaje
const MIN_INTERVALO_MS = 1100; // Nominatim: máx. ~1 req/seg

interface CacheEntry {
  direccion: string | null;
  expiraEn: number;
}

const cache = new Map<string, CacheEntry>();
let ultimaLlamada = 0;
let colaThrottle: Promise<void> = Promise.resolve();

function claveCache(lat: number, lng: number): string {
  // ~4 decimales ≈ 11 m de precisión: suficiente para agrupar posiciones
  // cercanas sin perder la calle exacta.
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function esperarTurno(): Promise<void> {
  const previa = colaThrottle;
  let liberar!: () => void;
  colaThrottle = new Promise((resolve) => {
    liberar = resolve;
  });
  return previa.then(async () => {
    const espera = ultimaLlamada + MIN_INTERVALO_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaLlamada = Date.now();
    liberar();
  });
}

/**
 * Dirección legible para un punto lat/lng, o `null` si Nominatim no
 * responde / no encuentra nada — nunca lanza, para no tumbar el endpoint
 * que la llama (mapas/hechos siguen funcionando solo con coordenadas).
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = claveCache(lat, lng);
  const cacheado = cache.get(key);
  if (cacheado && cacheado.expiraEn > Date.now()) return cacheado.direccion;

  try {
    await esperarTurno();
    const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      cache.set(key, { direccion: null, expiraEn: Date.now() + CACHE_TTL_MS });
      return null;
    }
    const body = (await res.json()) as { display_name?: string };
    const direccion = body.display_name ?? null;
    cache.set(key, { direccion, expiraEn: Date.now() + CACHE_TTL_MS });
    return direccion;
  } catch {
    // Sin cachear el fallo por red: puede ser transitorio, vale la pena
    // reintentar en la próxima llamada en vez de recordar un null 1h.
    return null;
  }
}
