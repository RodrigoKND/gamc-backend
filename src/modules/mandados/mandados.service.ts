import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { logAudit } from '@modules/auditoria/auditoria.service';

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
  const row = await db.mandado.create({
    data: {
      turnoId,
      guardiaId: input.guardiaId,
      descripcion: input.descripcion,
      lat: input.lat,
      lng: input.lng,
    },
  });
  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'crear_mandado',
    recurso: 'mandado',
    recursoId: row.id,
  });
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
