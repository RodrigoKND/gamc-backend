// Geometría territorial pura (sin BD) — GeoJSON en [lng, lat].
//
// Separa dos preguntas que antes usaban el mismo chequeo (cambios/04 §4.5):
//  · `puntoEnTerritorio`: ¿a qué EPI pertenece un punto? Sin tolerancia —
//    clasificar un hecho o un GPS no debe "estirar" una EPI 60 m sobre la
//    vecina.
//  · `trazadoDentro`: ¿un recorrido queda dentro de la EPI? Revisa el
//    trazado COMPLETO (cada segmento muestreado), no solo sus vértices: en
//    una EPI cóncava dos vértices interiores pueden unir un tramo que sale
//    del territorio (hallazgo H12). Aquí sí aplica una tolerancia de borde,
//    porque el ruteo por calles (OSRM) roza los límites.

type Ring = [number, number][];
export type PolygonCoords = Ring[];

export const TOLERANCIA_TRAZADO_M = 60;
const PASO_MUESTREO_M = 15;
const MAX_MUESTRAS_POR_SEGMENTO = 2_000;

export function poligonosDe(geojson: unknown): PolygonCoords[] {
  const g = geojson as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === 'Polygon') return [g.coordinates as PolygonCoords];
  if (g.type === 'MultiPolygon') return g.coordinates as PolygonCoords[];
  return [];
}

function enAnillo([x, y]: [number, number], ring: Ring): boolean {
  let dentro = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Contención estricta (exterior menos huecos), en cualquier componente de un MultiPolygon. */
export function puntoEnTerritorio(p: [number, number], poligonos: PolygonCoords[]): boolean {
  for (const [exterior, ...huecos] of poligonos) {
    if (exterior && enAnillo(p, exterior) && !huecos.some((h) => enAnillo(p, h))) return true;
  }
  return false;
}

// Distancia aproximada (m) de un punto a un segmento — proyección
// equirectangular, suficiente a escala de ciudad.
function distanciaSegmentoM(p: [number, number], a: [number, number], b: [number, number]): number {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111_320;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110_540;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * 110_540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function distanciaABordeM(p: [number, number], poligonos: PolygonCoords[]): number {
  let min = Infinity;
  for (const poly of poligonos) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const d = distanciaSegmentoM(p, ring[i - 1]!, ring[i]!);
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/** Dentro del territorio o a no más de `toleranciaM` de su borde. */
export function puntoEnPoligonos(p: [number, number], poligonos: PolygonCoords[], toleranciaM = TOLERANCIA_TRAZADO_M): boolean {
  return puntoEnTerritorio(p, poligonos) || distanciaABordeM(p, poligonos) <= toleranciaM;
}

export function distanciaM(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180) * 111_320;
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * 110_540);
}

export function esCoordenadaValida(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 90
  );
}

/**
 * Líneas [lng, lat][] de una geometría: array pelado de `trazado` (una
 * línea), GeoJSON Point (un punto), LineString/MultiLineString o los anillos
 * de un Polygon. Devuelve null si alguna coordenada es inválida (NaN,
 * fuera de rango, forma rara) — un trazado con basura no se "limpia" en
 * silencio, se rechaza.
 */
export function lineasDe(geo: unknown): [number, number][][] | null {
  const g = geo as { type?: string; coordinates?: unknown } | null;
  const comoLinea = (v: unknown): [number, number][] | null => {
    if (!Array.isArray(v)) return null;
    const out: [number, number][] = [];
    for (const c of v) {
      if (!esCoordenadaValida(c)) return null;
      out.push([c[0], c[1]]);
    }
    return out;
  };
  if (Array.isArray(geo)) {
    const l = comoLinea(geo);
    return l ? [l] : null;
  }
  if (!g || typeof g !== 'object') return null;
  switch (g.type) {
    case 'Point':
      return esCoordenadaValida(g.coordinates) ? [[[g.coordinates[0], g.coordinates[1]]]] : null;
    case 'LineString':
    case 'MultiPoint': {
      const l = comoLinea(g.coordinates);
      return l ? [l] : null;
    }
    case 'MultiLineString':
    case 'Polygon': {
      if (!Array.isArray(g.coordinates)) return null;
      const ls = g.coordinates.map(comoLinea);
      return ls.every(Boolean) ? (ls as [number, number][][]) : null;
    }
    default:
      return null;
  }
}

export interface ResultadoTrazado {
  dentro: boolean;
  /** Primer punto (muestra) que queda fuera, para el mensaje de error. */
  primerFuera: [number, number] | null;
}

/** Verifica TODO el recorrido (segmentos muestreados cada ~15 m), no solo los vértices. */
export function trazadoDentro(
  lineas: [number, number][][],
  poligonos: PolygonCoords[],
  toleranciaM = TOLERANCIA_TRAZADO_M,
): ResultadoTrazado {
  for (const linea of lineas) {
    if (linea.length === 1 && !puntoEnPoligonos(linea[0]!, poligonos, toleranciaM)) {
      return { dentro: false, primerFuera: linea[0]! };
    }
    for (let i = 1; i < linea.length; i++) {
      const a = linea[i - 1]!;
      const b = linea[i]!;
      const n = Math.min(MAX_MUESTRAS_POR_SEGMENTO, Math.max(1, Math.ceil(distanciaM(a, b) / PASO_MUESTREO_M)));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (!puntoEnPoligonos(p, poligonos, toleranciaM)) return { dentro: false, primerFuera: p };
      }
    }
  }
  return { dentro: true, primerFuera: null };
}
