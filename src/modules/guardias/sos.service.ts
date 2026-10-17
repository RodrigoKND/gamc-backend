import { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { EVENTS } from '@infra/realtime';
import { publicarSeguro } from '@modules/ejecuciones/ejecuciones.service';

// Atención de SOS (F2). Antes "resolver el SOS" era un efecto secundario de
// cambiar el estado operativo (o de asignarle una ruta al guardia): atendía
// solo la ÚLTIMA alerta, dejaba otras pendientes y forzaba 'en_servicio' aunque
// el guardia ya hubiera cerrado turno. Ahora:
//  · una alerta abierta = ping con es_sos y sos_estado null/'pendiente' (misma
//    definición en mapa, banner, campana y KPI);
//  · se atienden EXACTAMENTE las alertas indicadas (las que el operador vio):
//    un SOS nuevo que llegue después no se cierra con esa confirmación;
//  · el registro conserva es_sos = true (historial) y pasa a 'atendido';
//  · sin alertas abiertas, el estado operativo se deriva del turno real.

const PENDIENTE: Prisma.GuardiaTelemetriaWhereInput = { esSos: true, OR: [{ sosEstado: null }, { sosEstado: 'pendiente' }] };

export interface ResultadoAtencion {
  guardiaId: string;
  atendidas: string[];
  pendientes: number;
  estadoOperativo: 'en_servicio' | 'fuera_de_servicio' | 'emergencia';
}

export async function atenderSos(guardiaId: string, actorId: string, alertaIds?: string[]): Promise<ResultadoAtencion> {
  const res = await db.$transaction(async (tx) => {
    const [g] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM guardia WHERE id = ${guardiaId}::uuid FOR UPDATE`;
    if (!g) throw Errors.notFound('Guardia no encontrado.');
    const abiertas = await tx.guardiaTelemetria.findMany({
      where: { guardiaId, ...PENDIENTE },
      select: { id: true },
    });
    const pedidas = alertaIds ? new Set(alertaIds) : null;
    const atender = abiertas.filter((a) => !pedidas || pedidas.has(a.id.toString()));
    if (atender.length === 0) throw Errors.conflict('Este guardia no tiene alertas SOS pendientes (o ya fueron atendidas).');
    const ahora = new Date();
    await tx.guardiaTelemetria.updateMany({
      where: { id: { in: atender.map((a) => a.id) } },
      data: { sosEstado: 'atendido', sosAtendidoPorId: actorId, sosAtendidoEn: ahora },
    });
    const pendientes = abiertas.length - atender.length;
    let estadoOperativo: ResultadoAtencion['estadoOperativo'] = 'emergencia';
    if (pendientes === 0) {
      const turno = await tx.turno.findFirst({ where: { guardiaId, estado: 'en_servicio' }, select: { id: true } });
      estadoOperativo = turno ? 'en_servicio' : 'fuera_de_servicio';
      await tx.guardia.update({ where: { id: guardiaId }, data: { estadoOperativo } });
    }
    const atendidas = atender.map((a) => a.id.toString());
    await tx.auditLog.create({
      data: { actorUserId: actorId, accion: 'atender_sos', recurso: 'sos', recursoId: guardiaId, detalle: { alertas: atendidas, pendientes, estadoOperativo } },
    });
    return { guardiaId, atendidas, pendientes, estadoOperativo };
  });
  const sigueEnSos = res.pendientes > 0;
  publicarSeguro([
    { tipo: EVENTS.sosAtendido, payload: res },
    { tipo: EVENTS.guardiaUbicacion, payload: { guardiaId, estadoOperativo: res.estadoOperativo, ...(sigueEnSos ? {} : { esSos: false, sosEstado: 'atendido' }) } },
    { tipo: EVENTS.guardiaEstado, payload: { guardiaId, estadoOperativo: res.estadoOperativo, ...(sigueEnSos ? {} : { esSos: false }) } },
    ...(sigueEnSos ? [] : [{ tipo: EVENTS.sosNuevo, payload: { guardiaId, esSos: false, estadoOperativo: res.estadoOperativo } }]),
  ]);
  return res;
}

/** Atiende todas las alertas abiertas (compatibilidad con el endpoint de estado operativo). */
export async function atenderTodasLasAlertas(tx: Prisma.TransactionClient, guardiaId: string, actorId: string): Promise<number> {
  const r = await tx.guardiaTelemetria.updateMany({
    where: { guardiaId, ...PENDIENTE },
    data: { sosEstado: 'atendido', sosAtendidoPorId: actorId, sosAtendidoEn: new Date() },
  });
  return r.count;
}
