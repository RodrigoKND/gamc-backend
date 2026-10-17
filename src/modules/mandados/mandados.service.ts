import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { EVENTS, publishTerritorial, isRealtimeReady } from '@infra/realtime';
import { clasificarPunto, catalogoEpis } from '@modules/epis/index';
import { epiEfectiva, type Alcance } from '@modules/mapas/jurisdiccion';

// Mandados / comisiones puntuales del turno (BD_UNIFICADA §5.4). Los escribe
// el móvil; la web solo lee.

export interface MandadoRow {
  id: string;
  turnoId: string;
  guardiaId: string;
  descripcion: string;
  lat: number;
  lng: number;
  creadoEn: Date;
  /** F3: EPI por la ubicación del mandado (null = fuera de cobertura). */
  epiCodigo?: string | null;
  epiEstado?: string | null;
}

export interface CrearMandadoInput {
  guardiaId: string;
  turnoId?: string | null;
  descripcion: string;
  lat: number;
  lng: number;
}

async function resolverTurno(guardiaId: string, turnoId?: string | null): Promise<string> {
  if (turnoId) {
    const turno = await db.turno.findUnique({ where: { id: turnoId }, select: { guardiaId: true } });
    if (!turno || turno.guardiaId !== guardiaId) throw Errors.notFound('Turno no encontrado.');
    return turnoId;
  }
  const abierto = await db.turno.findFirst({
    where: { guardiaId, estado: 'en_servicio' },
    select: { id: true },
  });
  if (!abierto) throw Errors.conflict('No tiene un turno en servicio para registrar el mandado.');
  return abierto.id;
}

export async function crearMandado(input: CrearMandadoInput): Promise<MandadoRow> {
  const turnoId = await resolverTurno(input.guardiaId, input.turnoId);
  // F3: la EPI sale de la ubicación del mandado, no de la cuenta del guardia.
  const clasif = await clasificarPunto([input.lng, input.lat]);
  const row = await db.mandado.create({
    data: {
      turnoId,
      guardiaId: input.guardiaId,
      descripcion: input.descripcion,
      lat: input.lat,
      lng: input.lng,
      epiId: clasif.epiId,
      epiMetodo: 'ubicacion',
      epiEstado: clasif.estado,
      epiTerritorioVersion: clasif.version,
      epiClasificadoEn: new Date(),
    },
  });
  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'crear_mandado',
    recurso: 'mandado',
    recursoId: row.id,
  });
  if (isRealtimeReady()) {
    publishTerritorial(EVENTS.mandadoNuevo, row.epiId, {
      id: row.id,
      guardiaId: row.guardiaId,
      descripcion: row.descripcion,
      lat: row.lat,
      lng: row.lng,
      creadoEn: row.creadoEn,
      epiCodigo: clasif.epiCodigo,
    });
    publishTerritorial(EVENTS.hechoActualizado, row.epiId, { tipo: 'mandado', id: row.id });
  }
  return {
    id: row.id,
    turnoId: row.turnoId,
    guardiaId: row.guardiaId,
    descripcion: row.descripcion,
    lat: row.lat,
    lng: row.lng,
    creadoEn: row.creadoEn,
  };
}

export async function listMandadosDeGuardia(guardiaId: string, limit = 100): Promise<MandadoRow[]> {
  const rows = await db.mandado.findMany({
    where: { guardiaId },
    orderBy: { creadoEn: 'desc' },
    take: Math.min(Math.max(limit, 1), 300),
  });
  return rows.map((row) => ({
    id: row.id,
    turnoId: row.turnoId,
    guardiaId: row.guardiaId,
    descripcion: row.descripcion,
    lat: row.lat,
    lng: row.lng,
    creadoEn: row.creadoEn,
  }));
}

/**
 * Lectura web (F3): dentro del alcance territorial y con los filtros
 * aplicados en la BD. Antes se pedían los N más recientes de TODAS las EPIs
 * y se filtraba en memoria, así que un filtro por guardia podía devolver
 * menos filas de las que existían.
 */
export async function listMandadosRecientes(
  alcance: Alcance,
  filtros: { limit?: number; guardiaId?: string; desde?: Date } = {},
): Promise<(MandadoRow & { guardiaNombre: string | null })[]> {
  const epi = epiEfectiva(alcance, undefined);
  const codigos = new Map((await catalogoEpis()).map((e) => [e.id, e.codigo]));
  const rows = await db.mandado.findMany({
    where: {
      ...(epi ? { epiId: epi } : {}),
      ...(filtros.guardiaId ? { guardiaId: filtros.guardiaId } : {}),
      ...(filtros.desde ? { creadoEn: { gte: filtros.desde } } : {}),
    },
    orderBy: [{ creadoEn: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(filtros.limit ?? 50, 1), 300),
    include: { guardia: { select: { primerNombre: true, apellidoPaterno: true } } },
  });
  return rows.map((row: any) => ({
    id: row.id,
    turnoId: row.turnoId,
    guardiaId: row.guardiaId,
    descripcion: row.descripcion,
    lat: row.lat,
    lng: row.lng,
    creadoEn: row.creadoEn,
    epiCodigo: row.epiId ? (codigos.get(row.epiId) ?? null) : null,
    epiEstado: row.epiEstado ?? null,
    guardiaNombre: row.guardia ? `${row.guardia.primerNombre} ${row.guardia.apellidoPaterno}` : null,
  }));
}
