import { db } from '@infra/database';
import { Errors } from '@shared/errors';

// Jurisdicción por EPI (2026-10-05): el Operador/Admin solo puede crear,
// asignar o cancelar rutas dentro de SU EPI (`user.epi_id`). super_admin no
// tiene restricción. Los límites salen de `epi.poligono` (GeoJSON Polygon o
// MultiPolygon, [lng, lat]) — ver scripts/sql/06_epi_poligonos.sql.

type Ring = [number, number][];
type PolygonCoords = Ring[];

export interface Jurisdiccion {
  epiId: string;
  epiCodigo: string;
  epiNombre: string;
  poligonos: PolygonCoords[];
}

// Tolerancia del borde: el trazado viene ruteado por calles (OSRM) y puede
// rozar el límite aunque el Operador haya marcado puntos dentro.
const TOLERANCIA_M = 60;

function poligonosDe(geojson: unknown): PolygonCoords[] {
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

export function puntoEnPoligonos(p: [number, number], poligonos: PolygonCoords[]): boolean {
  for (const [exterior, ...huecos] of poligonos) {
    if (exterior && enAnillo(p, exterior) && !huecos.some((h) => enAnillo(p, h))) return true;
  }
  for (const poly of poligonos) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        if (distanciaSegmentoM(p, ring[i - 1]!, ring[i]!) <= TOLERANCIA_M) return true;
      }
    }
  }
  return false;
}

/** [lng, lat][] de cualquier geometría GeoJSON (o del array pelado de `trazado`). */
export function puntosDe(geo: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (v: unknown) => {
    if (!Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      out.push([v[0], v[1]]);
      return;
    }
    v.forEach(walk);
  };
  const g = geo as { coordinates?: unknown } | null;
  walk(g && typeof g === 'object' && !Array.isArray(g) ? g.coordinates : geo);
  return out;
}

/** null = sin restricción (super_admin). Lanza 403 si el usuario no tiene EPI. */
export async function jurisdiccionDe(principal: { id: string; role: string }): Promise<Jurisdiccion | null> {
  if (principal.role === 'super_admin') return null;
  const user = await db.user.findUnique({
    where: { id: principal.id },
    select: { epi: { select: { id: true, codigo: true, nombre: true, poligono: true } } },
  });
  if (!user?.epi) {
    throw Errors.forbidden('Tu cuenta no tiene una EPI asignada: no puedes modificar rutas. Pide al Super Administrador que te asigne una.');
  }
  return {
    epiId: user.epi.id,
    epiCodigo: user.epi.codigo,
    epiNombre: user.epi.nombre,
    poligonos: poligonosDe(user.epi.poligono),
  };
}

export function exigirMismaEpi(j: Jurisdiccion | null, epiId: string | null | undefined, que: string): void {
  if (!j) return;
  if (epiId !== j.epiId) {
    throw Errors.forbidden(`${que} no pertenece a tu jurisdicción (${j.epiNombre}).`);
  }
}

export function exigirDentroDeEpi(j: Jurisdiccion | null, geo: unknown): void {
  if (!j) return;
  if (j.poligonos.length === 0) {
    throw Errors.forbidden(`La jurisdicción ${j.epiNombre} no tiene límites geográficos configurados.`);
  }
  const puntos = puntosDe(geo);
  if (puntos.length === 0) {
    throw Errors.validation('La ruta no contiene coordenadas válidas para verificar su jurisdicción.');
  }
  const fuera = puntos.filter((p) => !puntoEnPoligonos(p, j.poligonos));
  if (fuera.length > 0) {
    throw Errors.forbidden(`La ruta sale de los límites de tu jurisdicción (${j.epiNombre}). Ajusta el trazado para que quede dentro.`);
  }
}

export async function episConPoligono() {
  const rows = await db.epi.findMany({
    where: { activo: true },
    orderBy: { codigo: 'asc' },
    select: { id: true, codigo: true, nombre: true, poligono: true },
  });
  return rows;
}

/** EPI cuyo polígono contiene el punto [lng, lat] (sin tolerancia), o null. */
export async function epiDePunto(p: [number, number]): Promise<string | null> {
  const epis = await db.epi.findMany({ where: { activo: true }, select: { id: true, poligono: true } });
  for (const e of epis) {
    for (const [exterior, ...huecos] of poligonosDe(e.poligono)) {
      if (exterior && enAnillo(p, exterior) && !huecos.some((h) => enAnillo(p, h))) return e.id;
    }
  }
  return null;
}
