import type { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';

// Turno / servicio del guardia (BD_UNIFICADA §5.1). Lo escribe SOLO el móvil;
// la web lo lee por sus propios endpoints. `distancia_metros` la calcula la
// API al cerrar con `fn_turno_distancia()`.

export interface TurnoRow {
  id: string;
  guardiaId: string;
  estado: string;
  selfieInicioUrl: string;
  latInicio: number;
  lngInicio: number;
  horaInicio: Date;
  latFin: number | null;
  lngFin: number | null;
  horaFin: Date | null;
  distanciaMetros: number;
  patrullaId: string | null;
  createdAt: Date;
}

type TurnoModel = Prisma.TurnoGetPayload<Record<string, never>>;

function toRow(t: TurnoModel): TurnoRow {
  return {
    id: t.id,
    guardiaId: t.guardiaId,
    estado: t.estado,
    selfieInicioUrl: t.selfieInicioUrl,
    latInicio: t.latInicio,
    lngInicio: t.lngInicio,
    horaInicio: t.horainicio,
    latFin: t.latFin,
    lngFin: t.lngFin,
    horaFin: t.horaFin,
    distanciaMetros: Number(t.distanciaMetros),
    patrullaId: t.patrullaId,
    createdAt: t.createdAt,
  };
}

export interface IniciarTurnoInput {
  guardiaId: string;
  selfieInicioUrl: string;
  lat: number;
  lng: number;
  horaInicio?: Date;
  patrullaId?: string | null;
}

export async function iniciarTurno(input: IniciarTurnoInput): Promise<TurnoRow> {
  const abierto = await db.turno.findFirst({
    where: { guardiaId: input.guardiaId, estado: 'en_servicio' },
    select: { id: true },
  });
  if (abierto) throw Errors.conflict('Ya tiene un turno en servicio. Ciérrelo antes de iniciar otro.');

  // Patrulla a enlazar: la indicada (si es suya) o la vigente del día.
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const patrulla = await db.patrulla.findFirst({
    where: {
      guardiaId: input.guardiaId,
      estado: { in: ['asignada', 'en_curso'] },
      fecha: { gte: hoy },
      ...(input.patrullaId ? { id: input.patrullaId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (input.patrullaId && !patrulla) {
    throw Errors.validation('La patrulla indicada no existe, no es suya o no es del día.');
  }

  let estadoResultante: 'en_servicio' | 'emergencia' = 'en_servicio';
  const turno = await db.$transaction(async (tx) => {
    const created = await tx.turno.create({
      data: {
        guardiaId: input.guardiaId,
        estado: 'en_servicio',
        selfieInicioUrl: input.selfieInicioUrl,
        latInicio: input.lat,
        lngInicio: input.lng,
        horainicio: input.horaInicio ?? new Date(),
        patrullaId: patrulla?.id ?? null,
      },
    });
    if (patrulla) {
      await tx.patrulla.update({
        where: { id: patrulla.id },
        data: { turnoId: created.id, estado: 'en_curso', iniciadaEn: new Date() },
      });
    }
    // Blindaje de emergencia (2026-09-15): si el guardia sigue en
    // 'emergencia' sin resolver, iniciar un turno nuevo (reconectar, volver
    // a abrir la app) NO debe sacarlo de emergencia — solo el operador con
    // "Marcar como resuelto" (clearSosAction) puede hacerlo. Antes esto
    // pisaba siempre a 'en_servicio', que era otra vía silenciosa para que
    // la emergencia "se resolviera sola" sin que nadie la atendiera.
    const actual = await tx.guardia.findUnique({ where: { id: input.guardiaId }, select: { estadoOperativo: true } });
    estadoResultante = actual?.estadoOperativo === 'emergencia' ? 'emergencia' : 'en_servicio';
    await tx.guardia.update({
      where: { id: input.guardiaId },
      // La selfie de inicio de turno pasa a ser la foto vigente del guardia
      // en Guardias (Web) — se actualiza en la misma transacción que el
      // estado operativo para que ambos cambien a la vez, nunca por separado.
      data: { estadoOperativo: estadoResultante, fotoUrl: input.selfieInicioUrl },
    });
    return created;
  });

  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'iniciar_turno',
    recurso: 'turno',
    recursoId: turno.id,
    detalle: { patrullaId: patrulla?.id ?? null },
  });
  publish(EVENTS.guardiaEstado, {
    guardiaId: input.guardiaId,
    estadoOperativo: estadoResultante,
    turnoId: turno.id,
  });
  const gInicio = await db.guardia.findUnique({ where: { id: input.guardiaId }, select: { primerNombre: true, apellidoPaterno: true } });
  const nombreInicio = gInicio ? `${gInicio.primerNombre} ${gInicio.apellidoPaterno}` : input.guardiaId;
  publish(EVENTS.turnoIniciado, {
    turnoId: turno.id,
    guardiaId: input.guardiaId,
    guardiaNombre: nombreInicio,
    estado: 'en_servicio',
  });
  // Si el guardia tenía una patrulla asignada, ahora pasa a en_curso — el
  // mapa de la web debe enterarse sin esperar polling.
  if (patrulla) {
    publish(EVENTS.patrullaAsignada, {
      id: patrulla.id,
      guardiaId: input.guardiaId,
      estado: 'en_curso',
      turnoId: turno.id,
    });
  }
  return toRow(turno);
}

export interface CerrarTurnoInput {
  turnoId: string;
  guardiaId: string;
  lat?: number | null;
  lng?: number | null;
  horaFin?: Date;
}

export async function cerrarTurno(input: CerrarTurnoInput): Promise<TurnoRow> {
  const turno = await db.turno.findUnique({ where: { id: input.turnoId } });
  if (!turno || turno.guardiaId !== input.guardiaId) throw Errors.notFound('Turno no encontrado.');
  if (turno.estado !== 'en_servicio') throw Errors.conflict('El turno ya fue cerrado o anulado.');

  const distanciaRows = await db.$queryRaw<{ distancia: number | null }[]>`
    select fn_turno_distancia(${input.turnoId}::uuid)::float8 as distancia`;
  const distancia = distanciaRows[0]?.distancia ?? 0;

  let estadoResultanteCierre: 'fuera_de_servicio' | 'emergencia' = 'fuera_de_servicio';
  const cerrado = await db.$transaction(async (tx) => {
    const updated = await tx.turno.update({
      where: { id: input.turnoId },
      data: {
        estado: 'finalizado',
        latFin: input.lat ?? null,
        lngFin: input.lng ?? null,
        horaFin: input.horaFin ?? new Date(),
        distanciaMetros: distancia ?? 0,
      },
    });
    await tx.patrulla.updateMany({
      where: { turnoId: input.turnoId, estado: 'en_curso' },
      data: { estado: 'completada', completadaEn: new Date() },
    });
    // Mismo blindaje que iniciarTurno: cerrar turno tampoco saca a un
    // guardia de 'emergencia' sin resolver — solo el operador.
    const actual = await tx.guardia.findUnique({ where: { id: input.guardiaId }, select: { estadoOperativo: true } });
    estadoResultanteCierre = actual?.estadoOperativo === 'emergencia' ? 'emergencia' : 'fuera_de_servicio';
    await tx.guardia.update({
      where: { id: input.guardiaId },
      data: { estadoOperativo: estadoResultanteCierre },
    });
    return updated;
  });

  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'cerrar_turno',
    recurso: 'turno',
    recursoId: input.turnoId,
    detalle: { distanciaMetros: Number(cerrado.distanciaMetros) },
  });
  publish(EVENTS.guardiaEstado, {
    guardiaId: input.guardiaId,
    estadoOperativo: estadoResultanteCierre,
    turnoId: input.turnoId,
  });
  const gCierre = await db.guardia.findUnique({ where: { id: input.guardiaId }, select: { primerNombre: true, apellidoPaterno: true } });
  const nombreCierre = gCierre ? `${gCierre.primerNombre} ${gCierre.apellidoPaterno}` : input.guardiaId;
  publish(EVENTS.turnoFinalizado, {
    turnoId: input.turnoId,
    guardiaId: input.guardiaId,
    guardiaNombre: nombreCierre,
    estado: 'finalizado',
    distanciaMetros: Number(cerrado.distanciaMetros),
  });
  return toRow(cerrado);
}

export async function listTurnosDeGuardia(guardiaId: string, limit = 50): Promise<TurnoRow[]> {
  const rows = await db.turno.findMany({
    where: { guardiaId },
    orderBy: { horainicio: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map(toRow);
}

// ── Recorrido (serie GPS de un turno) ──────────────────────────────────────
// Los puntos viven en `guardia_telemetria` (turno_id). Este es el read en
// serie que la web usa para dibujar la ruta real recorrida.

export interface RecorridoPunto {
  lat: number;
  lng: number;
  capturadoEn: Date;
  esSos: boolean;
}

export interface RecorridoResult {
  turnoId: string | null;
  guardiaId: string | null;
  total: number;
  /** `turno.distancia_metros` — solo cuando el recorrido está acotado a un turno. */
  distanciaMetros: number | null;
  puntos: RecorridoPunto[];
}

const RECORRIDO_MAX_PUNTOS = 20_000;

export async function recorridoDeTurno(
  turnoId: string,
  opts: { guardiaId?: string } = {},
): Promise<RecorridoResult> {
  const turno = await db.turno.findUnique({
    where: { id: turnoId },
    select: { id: true, guardiaId: true, distanciaMetros: true },
  });
  // Mismo mensaje si no existe o no es del guardia: no filtramos existencia.
  if (!turno || (opts.guardiaId && turno.guardiaId !== opts.guardiaId)) {
    throw Errors.notFound('Turno no encontrado.');
  }
  const puntos = await db.guardiaTelemetria.findMany({
    where: { turnoId },
    orderBy: { capturadoEn: 'asc' },
    take: RECORRIDO_MAX_PUNTOS,
    select: { lat: true, lng: true, capturadoEn: true, esSos: true },
  });
  return {
    turnoId,
    guardiaId: turno.guardiaId,
    total: puntos.length,
    distanciaMetros: Number(turno.distanciaMetros),
    puntos,
  };
}

export interface RecorridoQueryInput {
  turnoId?: string;
  guardiaId?: string;
  desde?: string;
  hasta?: string;
}

export async function recorridoQuery(q: RecorridoQueryInput): Promise<RecorridoResult> {
  if (q.turnoId) return recorridoDeTurno(q.turnoId);
  if (!q.guardiaId) throw Errors.validation('Indique turnoId o guardiaId.');

  const where: Prisma.GuardiaTelemetriaWhereInput = { guardiaId: q.guardiaId };
  if (q.desde || q.hasta) {
    where.capturadoEn = {};
    if (q.desde) where.capturadoEn.gte = new Date(q.desde);
    if (q.hasta) where.capturadoEn.lte = new Date(q.hasta);
  }
  const puntos = await db.guardiaTelemetria.findMany({
    where,
    orderBy: { capturadoEn: 'asc' },
    take: RECORRIDO_MAX_PUNTOS,
    select: { lat: true, lng: true, capturadoEn: true, esSos: true },
  });
  return {
    turnoId: null,
    guardiaId: q.guardiaId,
    total: puntos.length,
    distanciaMetros: null,
    puntos,
  };
}
