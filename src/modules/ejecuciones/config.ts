// Parámetros del patrullaje (F2).
// Centralizados acá para ajustarlos tras observar el comportamiento real.

export const MODALIDADES = ['coche', 'moto', 'a_pie', 'punto_fijo', 'oficina'] as const;
export type Modalidad = (typeof MODALIDADES)[number];

/** Máximo de guardias por ejecución (una unidad). Coche: 12 (pedido del usuario). */
export const CAPACIDAD_MAX: Record<Modalidad, number> = {
  coche: 12,
  moto: 2,
  a_pie: 3,
  punto_fijo: 2,
  oficina: 8,
};

/**
 * Distancia al trazado (m): ≤ verde = en ruta; ≤ amarillo = advertencia;
 * más lejos = alerta. Por modalidad (propuesta inicial, ajustable).
 */
export const UMBRALES_DESVIO_M: Record<Modalidad, { verde: number; amarillo: number }> = {
  a_pie: { verde: 50, amarillo: 150 },
  moto: { verde: 100, amarillo: 300 },
  coche: { verde: 100, amarillo: 400 },
  punto_fijo: { verde: 30, amarillo: 100 },
  oficina: { verde: 30, amarillo: 100 },
};

/**
 * Plazo para incorporarse (F7): al pasar a "en
 * curso" se fija una hora límite; si vence sin que el guardia haya llegado a
 * su ruta, deja de estar "incorporándose" y pasa a advertencia o alerta según
 * su distancia. Mismo modelo que el tiempo estimado del mapa (web
 * `lib/eta.ts`), pero con distancia en línea recta × sinuosidad (el servidor
 * no consulta el ruteo por calles) y siempre el valor PESIMISTA.
 */
export const INCORPORACION = {
  /** Calles urbanas no son rectas: distancia recta × este factor. */
  factorSinuosidad: 1.35,
  /** m/s: a pie con equipo ≈ 4,5 km/h; vehículo a flujo libre ≈ 30 km/h. */
  velocidadMs: { a_pie: 1.25, moto: 8.3, coche: 8.3 },
  /** Subir al vehículo / estacionar al llegar (s). */
  arranqueS: { a_pie: 0, moto: 30, coche: 60 },
  /** Multiplicador pesimista por franja horaria (los mismos de la web). */
  factorPesimista: {
    coche: { pico: 2.3, diurna: 1.6, nocturna: 1.25 },
    moto: { pico: 1.6, diurna: 1.35, nocturna: 1.15 },
    a_pie: { pico: 1.2, diurna: 1.2, nocturna: 1.15 },
  },
  /** Punto fijo / oficina: a pie hasta esta distancia (m); más lejos, en vehículo. */
  distanciaMaxAPieM: 1500,
  /** Plazo mínimo (s): nadie queda en rojo por llegar un minuto "tarde" desde cerca. */
  minimoS: 5 * 60,
} as const;

export const TIPOS_RUTA = ['establecida', 'guardada', 'dinamica'] as const;
export type TipoRuta = (typeof TIPOS_RUTA)[number];

/** Cada cuánto el servidor cierra las asignaciones vencidas (no depende de operadores conectados). */
export const VENCIMIENTO_INTERVALO_MS = 60_000;

export function esModalidad(v: unknown): v is Modalidad {
  return typeof v === 'string' && (MODALIDADES as readonly string[]).includes(v);
}
