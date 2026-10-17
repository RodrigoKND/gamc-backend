// Parámetros de la programación de rutas (F5).
// Centralizados acá para ajustarlos sin tocar la lógica.

/** La tarea de un horario se abre 15 min antes de su inicio (pedido del usuario). */
export const APERTURA_ANTICIPADA_MIN = 15;

/** Cada cuánto corre el planificador del servidor (abre, inicia y cierra horarios). */
export const PLANIFICADOR_INTERVALO_MS = 60_000;

/** Hora oficial de las programaciones (Bolivia, sin horario de verano). */
export const ZONA_HORARIA = 'America/La_Paz';

/** Duración de un horario: de 15 min a 24 h (24 h se declara explícitamente). */
export const DURACION_MIN_MIN = 15;
export const DURACION_MAX_MIN = 1440;

/** Horarios por programación y días que se pueden consultar de una vez en la agenda. */
export const VENTANAS_MAX = 14;
export const AGENDA_DIAS_MAX = 14;

/** Días ISO: 1 = lunes … 7 = domingo. */
export const DIAS_SEMANA = [1, 2, 3, 4, 5, 6, 7] as const;

// --- F6: asignación automática. Valores iniciales,
// ajustables sin tocar la lógica.

/** Ubicación válida: la última captura tiene menos de 10 min. */
export const AUTO_GPS_MAX_MIN = 10;
/** Reloj del celular adelantado tolerable; una captura más "del futuro" se ignora. */
export const AUTO_GPS_FUTURO_MAX_S = 120;
/** Precisión peor que esto (si el celular la informa) descarta al guardia. */
export const AUTO_PRECISION_MAX_M = 100;
/** Batería conocida y al menos este porcentaje. */
export const AUTO_BATERIA_MIN = 15;
/** Si faltan guardias, se vuelve a intentar cada minuto (cada pasada) hasta el fin del horario. */
export const AUTO_REINTENTO_MIN = 1;
/**
 * Radio de búsqueda automático (pedido del usuario): empieza en 3 km y, si en
 * 3 min no consigue a nadie, crece 2 km. Tope: 20 km (toda el área urbana);
 * nunca "cualquier distancia".
 */
export const AUTO_RADIO_INICIAL_M = 3000;
export const AUTO_RADIO_PASO_M = 2000;
export const AUTO_RADIO_ESPERA_MIN = 3;
export const AUTO_RADIO_MAX_M = 20_000;
/**
 * "Manual" al retirar a un guardia de un horario automático: el sistema espera
 * hasta 5 min a que el operador elija al reemplazo; luego (o en cuanto cierra
 * el selector) sigue solo en automático.
 */
export const AUTO_RESERVA_MANUAL_MIN = 5;
