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
  id: bigint;
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
    const estadoOperativo = esSos ? 'emergencia' : 'en_servicio';
    await tx.guardia.updateMany({
      where: { id: input.guardiaId },
      data: { estadoOperativo },
    });
    return row;
  });

  const payload: TelemetryResult = {
    id: result.id,
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
    esSos: payload.esSos,
    sosEstado: payload.sosEstado,
    estadoOperativo: esSos ? 'emergencia' : 'en_servicio',
    capturadoEn: payload.capturadoEn,
  });
  if (esSos) {
    publish(EVENTS.sosNuevo, payload);
  }
  return payload;
}