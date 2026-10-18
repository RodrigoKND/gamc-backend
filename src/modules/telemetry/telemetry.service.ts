import { db } from '@infra/database';
import { EVENTS, publish, publishTerritorial } from '@infra/realtime';
import { logger } from '@infra/logger';
import { despacharSos } from '@modules/guardias/sosDespacho';
import { Errors } from '@shared/errors';
import { evaluarEstadoRuta, limiteIncorporacion } from '@modules/ejecuciones/estadoRuta';
import { objetivoDe } from '@modules/ejecuciones/incorporacion';
import { clasificarPunto } from '@modules/epis/index';

/** Un ping con la hora del celular adelantada más que esto se rechaza. */
export const MAX_ADELANTO_RELOJ_MS = 5 * 60_000;

export interface TelemetryInput {
  guardiaId: string;
  turnoId?: string | null;
  lat: number;
  lng: number;
  precisionM?: number | null;
  velocidadMps?: number | null;
  bateriaPct?: number | null;
  esSos?: boolean;
  sosEstado?: string | null;
  capturadoEn: Date;
}

export interface TelemetryResult {
  /** `guardia_telemetria.id` es bigserial → se serializa como string (JSON no soporta BigInt). */
  id: string;
  guardiaId: string;
  turnoId: string | null;
  lat: number;
  lng: number;
  bateriaPct: number | null;
  esSos: boolean;
  sosEstado: string | null;
  capturadoEn: Date;
  /** F3: EPI en la que está el guardia según su ÚLTIMA posición válida. */
  epiActualCodigo: string | null;
}

// Punto GPS entrante (endpoint del móvil). Se persiste y se EMPUJA en vivo
// a la sala `dashboard`: el mapa de la web se actualiza sin polling.
// Si el guardia manda SOS, su estado operativo pasa a `emergencia` y se
// publica el evento de SOS pendiente.

export async function ingestTelemetry(input: TelemetryInput): Promise<TelemetryResult> {
  const esSos = input.esSos ?? false;
  // Validaciones de F3: hora del celular no adelantada y turno propio.
  if (input.capturadoEn.getTime() - Date.now() > MAX_ADELANTO_RELOJ_MS) {
    throw Errors.validation('La hora del GPS está adelantada respecto del servidor. Revisa la hora del celular.');
  }
  if (input.turnoId) {
    const turno = await db.turno.findUnique({ where: { id: input.turnoId }, select: { guardiaId: true } });
    if (!turno || turno.guardiaId !== input.guardiaId) throw Errors.validation('El turno indicado no pertenece a este guardia.');
  }
  const clasif = await clasificarPunto([input.lng, input.lat]);
  const result = await db.$transaction(async (tx) => {
    const row = await tx.guardiaTelemetria.create({
      data: {
        guardiaId: input.guardiaId,
        turnoId: input.turnoId ?? null,
        lat: input.lat,
        lng: input.lng,
        precisionM: input.precisionM ?? null,
        velocidadMps: input.velocidadMps ?? null,
        bateriaPct: input.bateriaPct ?? null,
        esSos,
        sosEstado: esSos ? (input.sosEstado ?? 'pendiente') : null,
        capturadoEn: input.capturadoEn,
      },
    });
    // BUG REAL 2026-09-15 ("se activa y se desactiva sin tocar nada"): esto
    // antes forzaba `estadoOperativo = 'en_servicio'` en TODO ping sin SOS —
    // incluyendo el ping GPS rutinario que el móvil manda cada ~45-90s
    // durante el turno (enviarUbicacion, RF-APP-05, que NUNCA manda esSos).
    // Resultado: activar el SOS ponía al guardia en 'emergencia' por un
    // instante, y el siguiente ping normal (segundos/minutos después, sin
    // que nadie tocara nada) lo revertía solo a 'en_servicio' otra vez —
    // en bucle, hasta que un operador lo resolvía o el guardia volvía a
    // apretar SOS. Un ping SIN SOS ya NO toca estadoOperativo: si el
    // guardia está en 'emergencia' se queda ahí hasta que un operador lo
    // resuelva explícito (clearSosAction/setEstadoOperativo) — solo un ping
    // CON esSos=true puede *activar* la emergencia.
    if (esSos) {
      await tx.guardia.updateMany({
        where: { id: input.guardiaId },
        data: { estadoOperativo: 'emergencia' },
      });
    }
    // EPI actual (F3): solo avanza con un ping MÁS NUEVO que el último
    // guardado (los pings atrasados de la cola offline se guardan en el
    // historial pero no mueven la posición actual). `epi_desde` cambia solo
    // si cambió la EPI; la frescura (capturado_en) se actualiza siempre.
    await tx.$executeRaw`
      INSERT INTO guardia_ubicacion_actual AS u (guardia_id, telemetria_id, lat, lng, precision_m, bateria_pct, capturado_en,
                                                recibido_en, epi_id, epi_estado, territorio_version, epi_desde, actualizado_en)
      VALUES (${input.guardiaId}::uuid, ${row.id}, ${input.lat}, ${input.lng}, ${input.precisionM ?? null}, ${input.bateriaPct ?? null},
              ${input.capturadoEn}, now(), ${clasif.epiId}::uuid, ${clasif.estado}, ${clasif.version}, ${input.capturadoEn}, now())
      ON CONFLICT (guardia_id) DO UPDATE SET
        telemetria_id = EXCLUDED.telemetria_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
        precision_m = EXCLUDED.precision_m, bateria_pct = EXCLUDED.bateria_pct,
        capturado_en = EXCLUDED.capturado_en, recibido_en = EXCLUDED.recibido_en,
        epi_desde = CASE WHEN u.epi_id IS DISTINCT FROM EXCLUDED.epi_id THEN EXCLUDED.capturado_en ELSE u.epi_desde END,
        epi_id = EXCLUDED.epi_id, epi_estado = EXCLUDED.epi_estado, territorio_version = EXCLUDED.territorio_version,
        actualizado_en = now()
      WHERE u.capturado_en < EXCLUDED.capturado_en
         OR (u.capturado_en = EXCLUDED.capturado_en AND coalesce(u.telemetria_id, 0) < EXCLUDED.telemetria_id)`;
    const actual = await tx.guardiaUbicacionActual.findUnique({ where: { guardiaId: input.guardiaId }, select: { epiId: true } });
    return { row, epiActualId: actual?.epiId ?? null };
  });
  const epiActualCodigo = result.epiActualId === clasif.epiId ? clasif.epiCodigo : await codigoDeEpi(result.epiActualId);

  const payload: TelemetryResult = {
    id: result.row.id.toString(),
    guardiaId: result.row.guardiaId,
    turnoId: result.row.turnoId,
    lat: result.row.lat,
    lng: result.row.lng,
    bateriaPct: result.row.bateriaPct,
    esSos: result.row.esSos,
    sosEstado: result.row.sosEstado,
    capturadoEn: result.row.capturadoEn,
    epiActualCodigo,
  };

  publish(EVENTS.telemetria, payload);
  publish(EVENTS.guardiaUbicacion, {
    guardiaId: payload.guardiaId,
    turnoId: payload.turnoId,
    lat: payload.lat,
    lng: payload.lng,
    capturadoEn: payload.capturadoEn,
    // bateriaPct SÍ va siempre (a diferencia de esSos/estadoOperativo, ver
    // abajo): antes faltaba en este evento por completo, así que el % de
    // batería del pin en el mapa solo se actualizaba con el poll completo
    // (cada 60s) o recargando la página — reportado explícitamente
    // 2026-09-19 ("la batería ya funciona pero no me actualiza automático").
    bateriaPct: payload.bateriaPct,
    epiActualCodigo: payload.epiActualCodigo,
    // Solo se manda esSos/estadoOperativo cuando el ping SÍ es una alerta
    // real — un ping rutinario no debe pisar en el cliente (MapasView, ver
    // el handler optimista de guardiaUbicacion) el hasSos/operationalStatus
    // que ya tenía el guardia, por la misma razón que ya no se pisa en BD.
    ...(esSos ? { esSos: true, sosEstado: payload.sosEstado, estadoOperativo: 'emergencia' as const } : {}),
  });
  if (esSos) {
    publish(EVENTS.sosNuevo, payload);
    // Además del aviso general, se dirige a quien le corresponde atenderlo.
    void despacharSos({ id: payload.id, guardiaId: payload.guardiaId, lat: payload.lat, lng: payload.lng, capturadoEn: payload.capturadoEn });
  }
  await actualizarEstadoRuta(payload).catch((err) => logger.warn({ err, guardiaId: payload.guardiaId }, 'No se pudo calcular el estado de ruta'));
  return payload;
}

/**
 * Estado del guardia respecto a su ruta (F2): lo calcula el SERVIDOR en cada
 * ping, así existe aunque nadie tenga el mapa abierto. Ignora pings más viejos
 * que el último evaluado (llegan desordenados) y no bloquea la ingesta si falla.
 */
async function actualizarEstadoRuta(ping: TelemetryResult): Promise<void> {
  const p = await db.patrulla.findFirst({
    where: { guardiaId: ping.guardiaId, estado: 'en_curso' },
    select: {
      id: true,
      modalidad: true,
      incorporadaEn: true,
      incorporacionLimite: true,
      estadoRuta: true,
      estadoRutaEn: true,
      ejecucionId: true,
      puntoFijoId: true,
      poligonoGeojson: true,
      ejecucion: { select: { trazado: true, modalidad: true, epiId: true } },
      rutaPlantilla: { select: { trazado: true } },
    },
  });
  if (!p) return;
  const capturado = new Date(ping.capturadoEn);
  if (p.estadoRutaEn && capturado < p.estadoRutaEn) return;
  const modalidad = p.modalidad ?? p.ejecucion?.modalidad ?? null;
  const ev = evaluarEstadoRuta(
    [ping.lng, ping.lat],
    // F4: en un punto fijo no hay trazado; se mide al punto (subpunto) asignado.
    objetivoDe(p),
    modalidad,
    Boolean(p.incorporadaEn),
    // F7: vencido el plazo sin llegar, cuenta como desvío (advertencia/alerta).
    Boolean(p.incorporacionLimite && capturado >= p.incorporacionLimite),
  );
  if (!ev) return;
  // F7: sin plazo todavía (no había posición al asignar, o patrulla anterior a 0012): lo fija este ping.
  const limiteNuevo = !p.incorporadaEn && !p.incorporacionLimite && !ev.seIncorpora ? limiteIncorporacion(ev.distanciaM, modalidad, capturado) : null;
  const r = await db.patrulla.updateMany({
    // Condición repetida en el UPDATE: dos pings concurrentes no se pisan al revés.
    where: { id: p.id, estado: 'en_curso', OR: [{ estadoRutaEn: null }, { estadoRutaEn: { lte: capturado } }] },
    data: {
      estadoRuta: ev.estado,
      distanciaRutaM: ev.distanciaM,
      estadoRutaEn: capturado,
      ...(ev.seIncorpora ? { incorporadaEn: capturado } : {}),
      ...(limiteNuevo ? { incorporacionLimite: limiteNuevo } : {}),
    },
  });
  if (r.count > 0 && ev.estado !== p.estadoRuta) {
    publishTerritorial(EVENTS.patrullaEstadoRuta, p.ejecucion?.epiId ?? null, {
      guardiaId: ping.guardiaId,
      patrullaId: p.id,
      ejecucionId: p.ejecucionId,
      epiId: p.ejecucion?.epiId ?? null,
      estado: ev.estado,
      distanciaM: ev.distanciaM,
    });
  }
}

async function codigoDeEpi(epiId: string | null): Promise<string | null> {
  if (!epiId) return null;
  return (await db.epi.findUnique({ where: { id: epiId }, select: { codigo: true } }))?.codigo ?? null;
}
