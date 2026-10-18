// Parámetros del despacho de SOS. Centralizados acá para ajustarlos tras
// observar el comportamiento real.

/** Rol que atiende un SOS: el único rol de EPI con `sos:editar`. */
export const ROL_ATIENDE_SOS = 'operador_monitoreo';

/** Rol que supervisa la EPI: recibe copia de cada SOS de su territorio. */
export const ROL_SUPERVISA_SOS = 'admin';

/** Sin atender en este tiempo, el SOS escala a la EPI vecina y a supervisión. */
export const SOS_ESCALAMIENTO_S = 120;

/** Cada cuánto se revisan los SOS pendientes para escalarlos. */
export const SOS_BARRIDO_INTERVALO_MS = 15_000;
