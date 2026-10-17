import { distanciaALineaM, lineasDe } from '@modules/epis/index';
import { ZONA_HORARIA } from '@modules/programacion/config';
import { INCORPORACION, UMBRALES_DESVIO_M, esModalidad } from './config.js';

// Estado de un guardia respecto a su ruta (F2). Puro: lo usa la ingesta de
// telemetría (servidor) en cada ping, así el estado existe aunque no haya
// ninguna pantalla abierta.
//   · incorporandose: aún no llegó a su ruta por primera vez (viaja hacia ella)
//     y no venció su plazo (F7);
//   · en_ruta / advertencia / alerta: según la distancia y la modalidad.

export type EstadoRuta = 'incorporandose' | 'en_ruta' | 'advertencia' | 'alerta';

export interface EvaluacionRuta {
  estado: EstadoRuta;
  distanciaM: number;
  /** true si este ping es el que lo incorpora (primera vez en verde). */
  seIncorpora: boolean;
}

/** Distancia (m) de una posición [lng, lat] al trazado o punto; null si no hay geometría. */
export function distanciaARutaM(posicion: [number, number], trazado: unknown): number | null {
  const lineas = lineasDe(trazado);
  if (!lineas || lineas.length === 0 || lineas.every((l) => l.length === 0)) return null;
  return Math.round(Math.min(...lineas.map((l) => distanciaALineaM(posicion, l))));
}

function umbrales(modalidad: string | null | undefined) {
  return UMBRALES_DESVIO_M[esModalidad(modalidad) ? modalidad : 'coche'];
}

/** Advertencia o alerta para quien está fuera del verde (desvío o plazo vencido). Sin distancia conocida: alerta. */
export function estadoFueraDeRuta(distanciaM: number | null, modalidad: string | null | undefined): 'advertencia' | 'alerta' {
  return distanciaM != null && distanciaM <= umbrales(modalidad).amarillo ? 'advertencia' : 'alerta';
}

export function evaluarEstadoRuta(
  posicion: [number, number],
  trazado: unknown,
  modalidad: string | null | undefined,
  yaIncorporado: boolean,
  /** F7: el plazo para incorporarse ya venció (sin plazo fijado no vence). */
  plazoVencido = false,
): EvaluacionRuta | null {
  const distanciaM = distanciaARutaM(posicion, trazado);
  if (distanciaM == null) return null;
  const enVerde = distanciaM <= umbrales(modalidad).verde;
  if (!yaIncorporado && !enVerde && !plazoVencido) return { estado: 'incorporandose', distanciaM, seIncorpora: false };
  const estado: EstadoRuta = enVerde ? 'en_ruta' : estadoFueraDeRuta(distanciaM, modalidad);
  return { estado, distanciaM, seIncorpora: !yaIncorporado && enVerde };
}

type Franja = 'pico' | 'diurna' | 'nocturna';

/** Horas pico de Cochabamba (hora de Bolivia), igual que la web (`lib/eta.ts`). */
export function franjaHoraria(fecha: Date): Franja {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(fecha);
  const dia = partes.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const h = Number(partes.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(partes.find((p) => p.type === 'minute')?.value ?? 0);
  const t = h * 60 + m;
  const entre = (a: number, b: number) => t >= a && t < b;
  const laborable = !['Sat', 'Sun'].includes(dia);
  if (laborable && (entre(7 * 60, 9 * 60) || entre(12 * 60, 14 * 60 + 30) || entre(17 * 60 + 30, 19 * 60 + 30))) return 'pico';
  if (dia === 'Sat' && entre(11 * 60 + 30, 13 * 60 + 30)) return 'pico';
  if (entre(6 * 60, 21 * 60)) return 'diurna';
  return 'nocturna';
}

/**
 * Hora límite para incorporarse (F7) saliendo en `desde` a `distanciaM` de la
 * ruta: tiempo de viaje pesimista + arranque, nunca menos de `minimoS`.
 */
export function limiteIncorporacion(distanciaM: number, modalidad: string | null | undefined, desde: Date): Date {
  const c = INCORPORACION;
  const d = Math.max(0, distanciaM);
  const medio: 'a_pie' | 'moto' | 'coche' =
    modalidad === 'a_pie' || modalidad === 'moto' || modalidad === 'coche'
      ? modalidad
      : (modalidad === 'punto_fijo' || modalidad === 'oficina') && d <= c.distanciaMaxAPieM
        ? 'a_pie'
        : 'coche';
  const viajeS = ((d * c.factorSinuosidad) / c.velocidadMs[medio]) * c.factorPesimista[medio][franjaHoraria(desde)];
  const segundos = Math.max(c.minimoS, Math.ceil(c.arranqueS[medio] + viajeS));
  return new Date(desde.getTime() + segundos * 1000);
}
