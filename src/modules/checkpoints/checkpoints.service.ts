import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { logAudit } from '@modules/auditoria/auditoria.service';

// Verificación periódica de ronda (selfie + GPS) durante el turno. NO es lo
// mismo que la telemetría GPS continua (`guardia_telemetria`, ~cada 15s/25m
// mientras el guardia camina): el checkpoint es una confirmación deliberada
// de presencia/identidad cada 30 minutos (`CHECKPOINT_INTERVALO_MS` en la
// app móvil), con foto. La escribe solo el móvil; la web solo lee.

export interface CheckpointRow {
  id: string;
  turnoId: string;
  guardiaId: string;
  estado: string;
  fotoUrl: string | null;
  lat: number | null;
  lng: number | null;
  capturadoEn: Date;
}

export interface CrearCheckpointInput {
  guardiaId: string;
  turnoId?: string | null;
  fotoUrl: string;
  lat: number;
  lng: number;
  capturadoEn?: Date;
}

// Mismo criterio que mandados.service.ts: si no manda turnoId explícito,
// se resuelve contra el turno abierto del guardia.
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
  if (!abierto) throw Errors.conflict('No tiene un turno en servicio para registrar el checkpoint.');
  return abierto.id;
}

function toRow(row: {
  id: string;
  turnoId: string;
  guardiaId: string;
  estado: string;
  fotoUrl: string | null;
  lat: number | null;
  lng: number | null;
  capturadoEn: Date;
}): CheckpointRow {
  return {
    id: row.id,
    turnoId: row.turnoId,
    guardiaId: row.guardiaId,
    estado: row.estado,
    fotoUrl: row.fotoUrl,
    lat: row.lat,
    lng: row.lng,
    capturadoEn: row.capturadoEn,
  };
}

export async function crearCheckpoint(input: CrearCheckpointInput): Promise<CheckpointRow> {
  const turnoId = await resolverTurno(input.guardiaId, input.turnoId);
  const row = await db.checkpoint.create({
    data: {
      turnoId,
      guardiaId: input.guardiaId,
      fotoUrl: input.fotoUrl,
      lat: input.lat,
      lng: input.lng,
      capturadoEn: input.capturadoEn ?? new Date(),
    },
  });
  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'registrar_checkpoint',
    recurso: 'checkpoint',
    recursoId: row.id,
  });
  return toRow(row);
}

export async function listCheckpointsDeGuardia(guardiaId: string, limit = 100): Promise<CheckpointRow[]> {
  const rows = await db.checkpoint.findMany({
    where: { guardiaId },
    orderBy: { capturadoEn: 'desc' },
    take: Math.min(Math.max(limit, 1), 300),
  });
  return rows.map(toRow);
}
