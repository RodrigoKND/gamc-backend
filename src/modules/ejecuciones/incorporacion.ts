import { db, type Tx } from '@infra/database';
import { EVENTS, publishTerritorial } from '@infra/realtime';
import { logger } from '@infra/logger';
import { distanciaARutaM, estadoFueraDeRuta, limiteIncorporacion } from './estadoRuta.js';

// Plazo para incorporarse (F7). Al pasar a "en
// curso" cada patrulla recibe una hora límite calculada desde la última
// posición conocida del guardia; si vence sin que haya llegado a su ruta, el
// planificador (cada minuto, aunque no haya pantallas abiertas) la pasa a
// advertencia o alerta según su distancia. Sin posición conocida, el plazo lo
// fija su primer ping (telemetría).

interface PatrullaObjetivo {
  puntoFijoId: string | null;
  poligonoGeojson: unknown;
  ejecucion: { trazado: unknown } | null;
  rutaPlantilla: { trazado: unknown } | null;
}

/** Contra qué se mide al guardia: el trazado de su ruta o, en un punto fijo, el punto (subpunto) asignado. */
export function objetivoDe(p: PatrullaObjetivo): unknown {
  return p.ejecucion?.trazado ?? p.rutaPlantilla?.trazado ?? (p.puntoFijoId ? p.poligonoGeojson : null);
}

/** Fija el plazo (y la distancia de partida) de patrullas que acaban de pasar a "en curso". */
export async function fijarPlazosIncorporacion(tx: Tx, patrullaIds: string[], desde: Date): Promise<void> {
  if (patrullaIds.length === 0) return;
  const patrullas = await tx.patrulla.findMany({
    where: { id: { in: patrullaIds }, estado: 'en_curso', incorporadaEn: null },
    select: {
      id: true,
      guardiaId: true,
      modalidad: true,
      puntoFijoId: true,
      poligonoGeojson: true,
      ejecucion: { select: { trazado: true, modalidad: true } },
      rutaPlantilla: { select: { trazado: true } },
    },
  });
  const ubicaciones = await tx.guardiaUbicacionActual.findMany({
    where: { guardiaId: { in: patrullas.map((p) => p.guardiaId) } },
    select: { guardiaId: true, lat: true, lng: true },
  });
  const posicionDe = new Map(ubicaciones.map((u) => [u.guardiaId, [u.lng, u.lat] as [number, number]]));
  for (const p of patrullas) {
    const posicion = posicionDe.get(p.guardiaId);
    if (!posicion) continue;
    const distanciaM = distanciaARutaM(posicion, objetivoDe(p));
    if (distanciaM == null) continue;
    await tx.patrulla.update({
      where: { id: p.id },
      data: { incorporacionLimite: limiteIncorporacion(distanciaM, p.modalidad ?? p.ejecucion?.modalidad, desde), distanciaRutaM: distanciaM },
    });
  }
}

/**
 * Pasa a advertencia/alerta a quien venció su plazo sin incorporarse. La
 * distancia es la del último ping evaluado (o la de partida); desconocida → alerta.
 */
export async function vencerIncorporaciones(ahora = new Date()): Promise<number> {
  const vencidas = await db.patrulla.findMany({
    where: { estado: 'en_curso', incorporadaEn: null, estadoRuta: 'incorporandose', incorporacionLimite: { lte: ahora } },
    select: { id: true, guardiaId: true, ejecucionId: true, modalidad: true, distanciaRutaM: true, ejecucion: { select: { modalidad: true, epiId: true } } },
    take: 500,
  });
  let cambiadas = 0;
  for (const p of vencidas) {
    const estado = estadoFueraDeRuta(p.distanciaRutaM, p.modalidad ?? p.ejecucion?.modalidad);
    // Misma condición en el UPDATE: si un ping lo incorporó entretanto, no se pisa.
    const r = await db.patrulla.updateMany({
      where: { id: p.id, estado: 'en_curso', incorporadaEn: null, estadoRuta: 'incorporandose' },
      data: { estadoRuta: estado },
    });
    if (r.count === 0) continue;
    cambiadas++;
    try {
      publishTerritorial(EVENTS.patrullaEstadoRuta, p.ejecucion?.epiId ?? null, {
        guardiaId: p.guardiaId,
        patrullaId: p.id,
        ejecucionId: p.ejecucionId,
        epiId: p.ejecucion?.epiId ?? null,
        estado,
        distanciaM: p.distanciaRutaM,
        motivo: 'plazo_incorporacion',
      });
    } catch (err) {
      logger.warn({ err, patrullaId: p.id }, 'No se pudo avisar el vencimiento del plazo de incorporación');
    }
  }
  return cambiadas;
}
