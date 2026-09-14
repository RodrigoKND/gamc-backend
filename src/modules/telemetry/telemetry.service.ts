import { db } from '@infra/database';
import { EVENTS, publish } from '@infra/realtime';

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
  esSos: boolean;
  sosEstado: string | null;
  capturadoEn: Date;
}

// Punto GPS entrante (endpoint del móvil). Se persiste y se EMPUJA en vivo
// a la sala `dashboard`: el mapa de la web se actualiza sin polling.
// Si el guardia manda SOS, su estado operativo pasa a `emergencia` y se
// publica el evento de SOS pendiente.

export async function ingestTelemetry(input: TelemetryInput): Promise<TelemetryResult> {
  const esSos = input.esSos ?? false;
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
    return row;
  });

  const payload: TelemetryResult = {
    id: result.id.toString(),
    guardiaId: result.guardiaId,
    turnoId: result.turnoId,
    lat: result.lat,
    lng: result.lng,
    esSos: result.esSos,
    sosEstado: result.sosEstado,
    capturadoEn: result.capturadoEn,
  };

  publish(EVENTS.telemetria, payload);
  publish(EVENTS.guardiaUbicacion, {
    guardiaId: payload.guardiaId,
    turnoId: payload.turnoId,
    lat: payload.lat,
    lng: payload.lng,
    capturadoEn: payload.capturadoEn,
    // Solo se manda esSos/estadoOperativo cuando el ping SÍ es una alerta
    // real — un ping rutinario no debe pisar en el cliente (MapasView, ver
    // el handler optimista de guardiaUbicacion) el hasSos/operationalStatus
    // que ya tenía el guardia, por la misma razón que ya no se pisa en BD.
    ...(esSos ? { esSos: true, sosEstado: payload.sosEstado, estadoOperativo: 'emergencia' as const } : {}),
  });
  if (esSos) {
    publish(EVENTS.sosNuevo, payload);
  }
  return payload;
}