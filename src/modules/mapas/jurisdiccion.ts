import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import {
  catalogoEpis,
  clasificarPunto,
  lineasDe,
  poligonosDeEpi,
  puntoEnPoligonos,
  trazadoDentro,
  type PolygonCoords,
} from '@modules/epis/index';

// Jurisdicción por EPI (2026-10-05): el Operador/Admin solo puede crear,
// asignar o cancelar rutas dentro de SU EPI (`user.epi_id`). super_admin no
// tiene restricción. Desde el catálogo v2 los límites salen
// del territorio VIGENTE de `epi_territorio` (no de `epi.poligono`, que
// queda como versión legado) y la geometría vive en @modules/epis.

export { puntoEnPoligonos };

export interface Jurisdiccion {
  epiId: string;
  epiCodigo: string;
  epiNombre: string;
  poligonos: PolygonCoords[];
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

/**
 * null = sin restricción (super_admin). Falla CERRADO (403) si la cuenta no
 * tiene EPI o si su EPI está inactiva (p. ej. Centro Cercado tras retirarla
 * del catálogo): nunca se interpreta como alcance global.
 */
export async function jurisdiccionDe(principal: { id: string; role: string }): Promise<Jurisdiccion | null> {
  if (principal.role === 'super_admin') return null;
  const user = await db.user.findUnique({
    where: { id: principal.id },
    select: { epi: { select: { id: true, codigo: true, nombre: true, activo: true } } },
  });
  if (!user?.epi) {
    throw Errors.forbidden('Tu cuenta no tiene una EPI asignada: no puedes ver ni modificar datos de una EPI. Pide al Super Administrador que te asigne una.');
  }
  if (!user.epi.activo) {
    throw Errors.forbidden(`Tu EPI (${user.epi.nombre}) ya no está operativa. Pide al Super Administrador que te asigne una EPI vigente.`);
  }
  return {
    epiId: user.epi.id,
    epiCodigo: user.epi.codigo,
    epiNombre: user.epi.nombre,
    poligonos: await poligonosDeEpi(user.epi.id),
  };
}

/**
 * Alcance de LECTURA del usuario web (F3): `global` (Super
 * Admin) o `epi` (su EPI administrativa). Una cuenta sin EPI o con la EPI
 * inactiva NO es global: jurisdiccionDe responde 403 (alcance denegado).
 * La ubicación física del usuario nunca participa.
 */
export type Alcance =
  | { tipo: 'global' }
  | { tipo: 'epi'; epiId: string; epiCodigo: string; epiNombre: string };

export async function alcanceDe(principal: { id: string; role: string }): Promise<Alcance> {
  const j = await jurisdiccionDe(principal);
  return j ? { tipo: 'epi', epiId: j.epiId, epiCodigo: j.epiCodigo, epiNombre: j.epiNombre } : { tipo: 'global' };
}

/**
 * Para lecturas GLOBALES que solo tienen una parte territorial (p. ej. la
 * lista de guardias, cuyo conteo de hechos es por EPI): una cuenta sin EPI
 * válida no recibe 403, recibe un alcance que no coincide con ninguna EPI
 * (la parte territorial queda vacía, nunca global).
 */
export const ALCANCE_VACIO: Alcance = { tipo: 'epi', epiId: '00000000-0000-0000-0000-000000000000', epiCodigo: '', epiNombre: 'sin EPI' };

export async function alcanceOVacio(principal: { id: string; role: string }): Promise<Alcance> {
  try {
    return await alcanceDe(principal);
  } catch (error) {
    if ((error as { code?: string }).code === 'FORBIDDEN') return ALCANCE_VACIO;
    throw error;
  }
}

/** EPI a la que se restringe la consulta (undefined = sin restricción). */
export function epiDeAlcance(a: Alcance): string | undefined {
  return a.tipo === 'epi' ? a.epiId : undefined;
}

/** ¿El registro de esta EPI está dentro del alcance? (los sin EPI, solo global). */
export function enAlcance(a: Alcance, epiId: string | null | undefined): boolean {
  return a.tipo === 'global' || (epiId != null && epiId === a.epiId);
}

/**
 * Filtro pedido por el cliente combinado con el alcance: el filtro solo
 * REDUCE, nunca amplía. Devuelve `null` si pide una EPI fuera de su alcance
 * (el llamador responde vacío).
 */
export function epiEfectiva(a: Alcance, pedida: string | undefined): string | undefined | null {
  if (a.tipo === 'global') return pedida;
  if (pedida && pedida !== a.epiId) return null;
  return a.epiId;
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
  const lineas = geo == null ? null : lineasDe(geo);
  if (!lineas || lineas.every((l) => l.length === 0)) {
    throw Errors.validation('La ruta no contiene coordenadas válidas para verificar su jurisdicción.');
  }
  if (!trazadoDentro(lineas, j.poligonos).dentro) {
    throw Errors.forbidden(`La ruta sale de los límites de tu jurisdicción (${j.epiNombre}). Ajusta el trazado para que quede dentro.`);
  }
}

/**
 * EPIs operativas con su territorio vigente, para la capa "cristal" del
 * mapa. Misma fuente y versión que el catálogo (/api/epis): mantiene la
 * forma {id, codigo, nombre, poligono} de antes y agrega numero/color/sede.
 */
export async function episConPoligono() {
  const epis = await catalogoEpis();
  return epis
    .filter((e) => e.operativa)
    .map((e) => ({
      id: e.id,
      codigo: e.codigo,
      numero: e.numero,
      nombre: e.nombre,
      nombreOficial: e.nombreOficial,
      color: e.color,
      sede: e.sede,
      poligono: e.territorio?.poligono ?? null,
      territorioVersion: e.territorio?.version ?? null,
      aproximado: e.territorio?.aproximado ?? true,
    }));
}

/** EPI operativa que contiene el punto [lng, lat] (sin tolerancia), o null. */
export async function epiDePunto(p: [number, number]): Promise<string | null> {
  const c = await clasificarPunto(p);
  return c.estado === 'fuera_cobertura' ? null : c.epiId;
}
