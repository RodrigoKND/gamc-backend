import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { EVENTS } from '@infra/realtime';
import { logger } from '@infra/logger';
import { AppError } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { distanciaALineaM, distanciaM } from '@modules/epis/index';
import { asignarEjecucion, publicarSeguro, type NoAsignado, type OpcionesAutomatica } from '@modules/ejecuciones/ejecuciones.service';
import {
  AUTO_BATERIA_MIN,
  AUTO_GPS_FUTURO_MAX_S,
  AUTO_GPS_MAX_MIN,
  AUTO_PRECISION_MAX_M,
  AUTO_RADIO_ESPERA_MIN,
  AUTO_RADIO_INICIAL_M,
  AUTO_RADIO_MAX_M,
  AUTO_RADIO_PASO_M,
  AUTO_REINTENTO_MIN,
} from './config.js';

// Asignación automática de horarios programados (F6).
// Los horarios automáticos se gestionan solos lo más posible (pedido del
// usuario). Para cada horario automático abierto al que le faltan guardias:
//  1. Lo RECLAMA con su fila bloqueada (FOR UPDATE SKIP LOCKED) y deja
//     anotado el próximo intento: dos servidores no lo intentan a la vez.
//  2. Radio automático: empieza en 3 km; si pasan 3 min sin conseguir a
//     nadie, crece 2 km (hasta 20 km, toda el área urbana) y vuelve a buscar.
//  3. Busca candidatos FUERA de la transacción de escritura: guardias con
//     cuenta activa, turno abierto, sin SOS, sin otra ruta (no se retira
//     a nadie), GPS de menos de 10 min, precisión aceptable, batería conocida
//     ≥ 15 % y dentro del radio. Quien un operador retiró de ESTE
//     horario no vuelve: no hay ida y vuelta.
//  4. Los ordena por distancia a la ruta (o al punto fijo) y, a igual
//     distancia, por id (desempate estable). Elige los que faltan.
//  5. Asigna con el MOTOR de siempre, que vuelve a comprobar todo con los
//     guardias bloqueados; si alguno dejó de cumplir, queda fuera.
//  6. Guarda el resultado (a quién eligió con su distancia, a quién descartó
//     y por qué) y, si siguen faltando, reintenta cada minuto hasta el fin.
//
// Retirar a un guardia de un horario automático: el operador elige
// "Continuar" (se busca el reemplazo más cercano al momento) o "Manual" (elige
// él al reemplazo; el sistema le espera hasta 5 min y luego sigue solo). El
// horario siempre sigue siendo automático. Quien sale por fin de turno se
// repone solo.

/** Motivos de cierre de una asignación que son decisión de un operador: ese guardia no vuelve al horario. */
export const RETIROS_MANUALES = ['retirado_por_usuario', 'reasignada'];

const ACTIVAS = ['asignada', 'en_curso'];
const MODALIDADES_EN_UNIDAD = ['coche', 'moto'];

type MotivoAuto = NoAsignado['motivo'];

const MENSAJE: Partial<Record<MotivoAuto, string>> = {
  sos: 'Tiene un SOS sin atender.',
  sin_turno: 'No está en servicio.',
  ocupado: 'Ya tiene otra ruta.',
  retirado: 'Un operador lo retiró de este horario.',
  sin_gps: 'No reporta GPS.',
  gps_antiguo: `Su GPS tiene más de ${AUTO_GPS_MAX_MIN} min.`,
  gps_impreciso: `Su GPS es impreciso (más de ${AUTO_PRECISION_MAX_M} m).`,
  bateria_baja: `Batería por debajo de ${AUTO_BATERIA_MIN} %.`,
  bateria_desconocida: 'No informa su batería.',
  fuera_de_radio: 'Está fuera del radio de búsqueda.',
};

export interface FilaCandidato {
  id: string;
  primer_nombre: string;
  segundo_nombre: string | null;
  apellido_paterno: string;
  apellido_materno: string;
  estado_operativo: string;
  sos: boolean;
  ocupado: boolean;
  /** Un operador lo retiró de este horario. */
  retirado: boolean;
  lat: number | null;
  lng: number | null;
  capturado_en: Date | null;
  bateria_pct: number | null;
  precision_m: Prisma.Decimal | null;
}

export interface Evaluado {
  guardiaId: string;
  nombre: string;
  /** null = apto. */
  motivo: MotivoAuto | null;
  distanciaM: number | null;
  gpsEdadMin: number | null;
  bateria: number | null;
  posicion: { lat: number; lng: number } | null;
}

/** Destino de la ejecución: trazado [lng, lat][] de la ruta o coordenada del punto fijo. */
export interface Destino {
  trazado: [number, number][] | null;
  punto: { lat: number; lng: number } | null;
}

function destinoDe(e: { trazado: Prisma.JsonValue; destino: Prisma.JsonValue }): Destino {
  const d = e.destino as { lat?: number; lng?: number } | null;
  if (d && typeof d.lat === 'number' && typeof d.lng === 'number') return { trazado: null, punto: { lat: d.lat, lng: d.lng } };
  const t = e.trazado as [number, number][] | null;
  return { trazado: Array.isArray(t) && t.length > 0 ? t : null, punto: null };
}

function distanciaAlDestino(p: { lat: number; lng: number }, d: Destino): number {
  if (d.punto) return distanciaM([p.lng, p.lat], [d.punto.lng, d.punto.lat]);
  if (d.trazado) return distanciaALineaM([p.lng, p.lat], d.trazado);
  return Infinity;
}

/**
 * Lee los guardias EN SERVICIO (turno abierto) con su última ubicación
 * válida. Una captura con la hora "del futuro" (reloj adelantado más de lo
 * tolerable) no cuenta: se usa la anterior. `ids` limita la lectura (dentro
 * de la transacción del motor, a los guardias ya bloqueados).
 */
async function leerGuardias(tx: Tx | typeof db, ejecucionId: string, ahora: Date, ids?: string[]): Promise<FilaCandidato[]> {
  const limiteFuturo = new Date(ahora.getTime() + AUTO_GPS_FUTURO_MAX_S * 1000);
  return tx.$queryRaw<FilaCandidato[]>`
    SELECT g.id, g.primer_nombre, g.segundo_nombre, g.apellido_paterno, g.apellido_materno, g.estado_operativo::text,
      EXISTS (SELECT 1 FROM guardia_telemetria s WHERE s.guardia_id = g.id AND s.es_sos AND (s.sos_estado IS NULL OR s.sos_estado = 'pendiente')) AS sos,
      EXISTS (SELECT 1 FROM patrulla p WHERE p.guardia_id = g.id AND p.estado IN ('asignada', 'en_curso')) AS ocupado,
      EXISTS (SELECT 1 FROM patrulla p WHERE p.guardia_id = g.id AND p.ejecucion_id = ${ejecucionId}::uuid AND p.motivo_cierre = ANY(${RETIROS_MANUALES}::text[])) AS retirado,
      t.lat, t.lng, t.capturado_en, t.bateria_pct, t.precision_m
    FROM guardia g
    LEFT JOIN LATERAL (
      SELECT lat, lng, capturado_en, bateria_pct, precision_m FROM guardia_telemetria
      WHERE guardia_id = g.id AND capturado_en <= ${limiteFuturo}
      ORDER BY capturado_en DESC LIMIT 1
    ) t ON true
    WHERE g.estado = 'activo'
      AND EXISTS (SELECT 1 FROM turno tu WHERE tu.guardia_id = g.id AND tu.estado = 'en_servicio')
      ${ids ? Prisma.sql`AND g.id = ANY(${ids}::uuid[])` : Prisma.empty}
    ORDER BY g.id`;
}

/** Requisitos automáticos de un guardia en servicio, en orden: el primero que falla es su motivo. */
export function evaluar(f: FilaCandidato, destino: Destino, radioM: number, ahora: Date): Evaluado {
  const nombre = nombreCompleto({ primerNombre: f.primer_nombre, segundoNombre: f.segundo_nombre, apellidoPaterno: f.apellido_paterno, apellidoMaterno: f.apellido_materno });
  const posicion = f.lat != null && f.lng != null ? { lat: Number(f.lat), lng: Number(f.lng) } : null;
  const gpsEdadMin = f.capturado_en ? Math.max(0, (ahora.getTime() - new Date(f.capturado_en).getTime()) / 60_000) : null;
  const distancia = posicion ? distanciaAlDestino(posicion, destino) : null;
  const base = { guardiaId: f.id, nombre, distanciaM: distancia != null && Number.isFinite(distancia) ? Math.round(distancia) : null, gpsEdadMin: gpsEdadMin != null ? Math.round(gpsEdadMin * 10) / 10 : null, bateria: f.bateria_pct, posicion };
  let motivo: MotivoAuto | null = null;
  if (f.sos || f.estado_operativo === 'emergencia') motivo = 'sos';
  else if (f.estado_operativo !== 'en_servicio') motivo = 'sin_turno';
  else if (f.ocupado) motivo = 'ocupado';
  else if (f.retirado) motivo = 'retirado';
  else if (!posicion || gpsEdadMin == null) motivo = 'sin_gps';
  else if (gpsEdadMin >= AUTO_GPS_MAX_MIN) motivo = 'gps_antiguo';
  else if (f.precision_m != null && Number(f.precision_m) > AUTO_PRECISION_MAX_M) motivo = 'gps_impreciso';
  else if (f.bateria_pct == null) motivo = 'bateria_desconocida';
  else if (f.bateria_pct < AUTO_BATERIA_MIN) motivo = 'bateria_baja';
  else if (distancia == null || distancia > radioM) motivo = 'fuera_de_radio';
  return { ...base, motivo };
}

/** Candidatos ordenados (más cercano primero; empate: id) y descartados con su motivo. */
export async function candidatosPara(
  tx: Tx | typeof db,
  e: { id: string; trazado: Prisma.JsonValue; destino: Prisma.JsonValue; autoRadioM: number | null },
  ahora = new Date(),
  ids?: string[],
) {
  const destino = destinoDe(e);
  const radio = e.autoRadioM ?? AUTO_RADIO_INICIAL_M;
  const evaluados = (await leerGuardias(tx, e.id, ahora, ids)).map((f) => evaluar(f, destino, radio, ahora));
  const aptos = evaluados
    .filter((x) => x.motivo === null)
    .sort((a, b) => a.distanciaM! - b.distanciaM! || (a.guardiaId < b.guardiaId ? -1 : 1));
  return { aptos, descartados: evaluados.filter((x) => x.motivo !== null), destino };
}

/**
 * Radio de búsqueda: el actual, o 2 km más si pasaron 3 min (desde que se
 * fijó o desde la última asignación) sin conseguir a nadie. Tope: 20 km.
 */
export function radioDeBusqueda(radioM: number | null, desde: Date, ahora: Date): { radioM: number; desde: Date; amplio: boolean } {
  const actual = radioM ?? AUTO_RADIO_INICIAL_M;
  if (actual < AUTO_RADIO_MAX_M && ahora.getTime() - desde.getTime() >= AUTO_RADIO_ESPERA_MIN * 60_000) {
    return { radioM: Math.min(AUTO_RADIO_MAX_M, actual + AUTO_RADIO_PASO_M), desde: ahora, amplio: true };
  }
  return { radioM: actual, desde, amplio: false };
}

/** Punto más cercano del trazado (vértice), como el asistente de la web. */
function verticeCercano(trazado: [number, number][], p: { lat: number; lng: number }): [number, number] {
  return trazado.reduce((mejor, v) => (distanciaM([p.lng, p.lat], v) < distanciaM([p.lng, p.lat], mejor) ? v : mejor));
}

/**
 * Punto de incorporación de cada elegido en una ruta: coche y moto viajan
 * juntos (un punto común, el más cercano al centro del grupo); a pie, cada
 * uno al punto del trazado más cercano a él. Punto fijo: lo fija el motor.
 */
export function puntosDeIncorporacion(modalidad: string, destino: Destino, elegidos: Evaluado[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!destino.trazado) return out;
  if (MODALIDADES_EN_UNIDAD.includes(modalidad)) {
    const c = {
      lat: elegidos.reduce((s, g) => s + g.posicion!.lat, 0) / elegidos.length,
      lng: elegidos.reduce((s, g) => s + g.posicion!.lng, 0) / elegidos.length,
    };
    const comun = verticeCercano(destino.trazado, c);
    for (const g of elegidos) out.set(g.guardiaId, comun);
  } else {
    for (const g of elegidos) out.set(g.guardiaId, verticeCercano(destino.trazado, g.posicion!));
  }
  return out;
}

/**
 * Requisitos automáticos revisados DENTRO de la transacción del motor, con los
 * guardias ya bloqueados: quien dejó de cumplirlos desde que se lo eligió
 * (GPS, batería, radio, turno, SOS) queda fuera con su motivo.
 */
export const requisitosAutomaticos: OpcionesAutomatica['requisitos'] = async (tx, ids, ejecucion) => {
  const { aptos: ok, descartados: ya } = await candidatosPara(tx, ejecucion, new Date(), ids);
  const siguen = new Set(ok.map((x) => x.guardiaId));
  return ids
    .filter((gid) => !siguen.has(gid))
    .map((gid) => {
      const d = ya.find((x) => x.guardiaId === gid);
      const motivo = d?.motivo ?? 'sin_turno';
      return { guardiaId: gid, guardiaNombre: d?.nombre ?? gid, motivo, mensaje: MENSAJE[motivo] ?? 'Ya no cumple los requisitos.' };
    });
};

const resumenDescartes = (d: { motivo: MotivoAuto | null }[]) =>
  d.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.motivo!]: (acc[x.motivo!] ?? 0) + 1 }), {});

export interface ResultadoIntento {
  ejecucionId: string;
  intento: number;
  asignados: number;
  faltan: number;
  radioM: number;
  /** El radio creció en este intento. */
  amplio: boolean;
  error?: string;
}

/**
 * Horarios automáticos abiertos a los que les faltan guardias y les toca
 * intento. Si dos compiten por los mismos guardias, va primero el que empieza
 * antes (luego id, estable).
 */
async function porIntentar(ahora: Date, soloId?: string) {
  return db.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM ruta_ejecucion e
    WHERE e.asignacion_modo = 'automatica'
      AND e.estado IN ('pendiente', 'incompleta')
      AND e.fin > ${ahora}
      AND (e.auto_proximo_intento IS NULL OR e.auto_proximo_intento <= ${ahora})
      AND (SELECT count(*) FROM patrulla p WHERE p.ejecucion_id = e.id AND p.estado IN ('asignada', 'en_curso')) < e.capacidad
      ${soloId ? Prisma.sql`AND e.id = ${soloId}::uuid` : Prisma.empty}
    ORDER BY e.inicio, e.id`;
}

/**
 * Reclama el intento: con la fila bloqueada (sin esperar a otro servidor que
 * ya la tenga) vuelve a comprobar que toca y anota el próximo. Devuelve el
 * número de intento, o null si otro servidor lo tomó.
 */
async function reclamar(id: string, ahora: Date): Promise<number | null> {
  return db.$transaction(async (tx) => {
    const [f] = await tx.$queryRaw<{ auto_intentos: number }[]>`
      SELECT auto_intentos FROM ruta_ejecucion
      WHERE id = ${id}::uuid AND asignacion_modo = 'automatica' AND estado IN ('pendiente', 'incompleta') AND fin > ${ahora}
        AND (auto_proximo_intento IS NULL OR auto_proximo_intento <= ${ahora})
      FOR UPDATE SKIP LOCKED`;
    if (!f) return null;
    const proximo = new Date(ahora.getTime() + AUTO_REINTENTO_MIN * 60_000);
    await tx.$executeRaw`UPDATE ruta_ejecucion SET auto_proximo_intento = ${proximo}, auto_intentos = auto_intentos + 1 WHERE id = ${id}::uuid`;
    return f.auto_intentos + 1;
  });
}

/** UN intento sobre un horario automático ya reclamado. Nunca lanza: devuelve el error. */
async function intentar(id: string, intento: number, ahora: Date): Promise<ResultadoIntento> {
  const e0 = await db.rutaEjecucion.findUniqueOrThrow({ where: { id }, include: { programacion: { select: { creadoPorId: true, actualizadoPorId: true } } } });
  const previo = (e0.autoUltimo as { radioDesde?: string } | null) ?? null;
  // Radio: crece si pasaron 3 min sin conseguir a nadie (se cuenta desde que se fijó o desde la última asignación).
  const radio = radioDeBusqueda(e0.autoRadioM, new Date(previo?.radioDesde ?? e0.apertura ?? ahora), ahora);
  if (radio.radioM !== e0.autoRadioM) await db.rutaEjecucion.update({ where: { id }, data: { autoRadioM: radio.radioM } });
  const e = { ...e0, autoRadioM: radio.radioM };

  const activos = await db.patrulla.count({ where: { ejecucionId: id, estado: { in: ACTIVAS as ('asignada' | 'en_curso')[] } } });
  const faltanAntes = Math.max(0, e.capacidad - activos);
  const { aptos, descartados, destino } = await candidatosPara(db, e, ahora);
  const elegidos = aptos.slice(0, faltanAntes);
  let asignados = 0;
  let rechazados: NoAsignado[] = [];
  let error: string | undefined;
  const autor = e.programacion?.actualizadoPorId ?? e.programacion?.creadoPorId ?? e.creadoPorId;
  if (elegidos.length > 0 && autor) {
    const puntos = puntosDeIncorporacion(e.modalidad, destino, elegidos);
    try {
      const r = await asignarEjecucion({
        actor: { id: autor, role: 'sistema', permissions: {} },
        jurisdiccion: null,
        claveIdempotencia: randomUUID(),
        ejecucionId: id,
        guardias: elegidos.map((g) => ({ guardiaId: g.guardiaId, punto: puntos.get(g.guardiaId) ?? null })),
        // Con los guardias bloqueados: ¿siguen cumpliendo GPS, batería y radio?
        automatica: { requisitos: requisitosAutomaticos },
      });
      asignados = r.patrullaIds.length;
      rechazados = r.noAsignados;
    } catch (err) {
      if (err instanceof AppError && err.code === 'SIN_GUARDIAS_ASIGNABLES') {
        rechazados = (err.issues as { noAsignados?: NoAsignado[] } | undefined)?.noAsignados ?? [];
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const faltan = Math.max(0, faltanAntes - asignados);
  const elegidosOk = elegidos.filter((g) => !rechazados.some((r) => r.guardiaId === g.guardiaId));
  const excluidos = [
    ...descartados.map((d) => ({ guardiaId: d.guardiaId, nombre: d.nombre, motivo: d.motivo, distanciaM: d.distanciaM, gpsEdadMin: d.gpsEdadMin, bateria: d.bateria })),
    ...rechazados.map((r) => ({ guardiaId: r.guardiaId, nombre: r.guardiaNombre, motivo: r.motivo, distanciaM: elegidos.find((g) => g.guardiaId === r.guardiaId)?.distanciaM ?? null, alAsignar: true })),
  ];
  const ultimo = {
    en: ahora,
    intento,
    asignados,
    faltan,
    candidatos: aptos.length,
    radioM: radio.radioM,
    // Conseguir a alguien reinicia la espera antes de ampliar el radio.
    radioDesde: asignados > 0 ? ahora : radio.desde,
    elegidos: elegidosOk.map((g) => ({ guardiaId: g.guardiaId, nombre: g.nombre, distanciaM: g.distanciaM })),
    descartes: resumenDescartes(excluidos),
    ...(error ? { error } : {}),
  };
  await db.rutaEjecucion.update({
    where: { id },
    // Cubierto: no hace falta otro intento (si alguien sale, vuelve a tocar).
    data: { autoUltimo: ultimo as unknown as Prisma.InputJsonValue, ...(faltan === 0 ? { autoProximoIntento: null } : {}) },
  });
  // Historial: el primer intento, los que asignaron, ampliaron el radio o fallaron (no cada reintento vacío).
  if (intento === 1 || asignados > 0 || radio.amplio || error) {
    await db.asignacionAutomaticaIntento.create({
      data: {
        ejecucionId: id,
        intento,
        ejecutadoEn: ahora,
        asignados,
        faltan,
        candidatos: aptos.length,
        elegidos: ultimo.elegidos as unknown as Prisma.InputJsonValue,
        radioM: radio.radioM,
        excluidos: excluidos.slice(0, 100) as unknown as Prisma.InputJsonValue,
        error: error ?? null,
      },
    });
  }
  // Agenda y campana al momento: si asignó, el motor ya avisó; si no, se avisa
  // cuando cambia algo que el operador ve (primer intento, radio, error).
  if (asignados === 0 && (intento === 1 || radio.amplio || error)) {
    publicarSeguro([
      {
        tipo: EVENTS.programacionActualizada,
        epiId: e.epiId,
        payload: { ejecucionId: id, programacionId: e.programacionId, estado: e.estado, nombre: e.nombre, soloAgenda: true },
      },
    ]);
  }
  return { ejecucionId: id, intento, asignados, faltan, radioM: radio.radioM, amplio: radio.amplio, ...(error ? { error } : {}) };
}

/** Paso automático de una pasada del planificador. */
export async function asignacionesAutomaticas(ahora = new Date()): Promise<ResultadoIntento[]> {
  const out: ResultadoIntento[] = [];
  for (const { id } of await porIntentar(ahora)) {
    const intento = await reclamar(id, ahora);
    if (intento === null) continue;
    out.push(await intentar(id, intento, ahora));
  }
  return out;
}

/**
 * Intento inmediato sobre UN horario (tras retirar a un guardia con
 * "Continuar" o al volver a automática): no espera la próxima pasada. Respeta
 * el interruptor del planificador. Se llama sin esperar la respuesta.
 */
export async function intentarAhora(ejecucionId: string): Promise<ResultadoIntento | null> {
  try {
    const estado = await db.planificadorEstado.findUnique({ where: { id: 1 }, select: { habilitado: true } });
    if (estado && !estado.habilitado) return null;
    const ahora = new Date();
    const [fila] = await porIntentar(ahora, ejecucionId);
    if (!fila) return null;
    const intento = await reclamar(ejecucionId, ahora);
    return intento === null ? null : await intentar(ejecucionId, intento, ahora);
  } catch (err) {
    logger.warn({ err, ejecucionId }, 'Intento automático inmediato fallido (se reintenta en la próxima pasada)');
    return null;
  }
}
