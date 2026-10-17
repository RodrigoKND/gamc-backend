import { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { EVENTS } from '@infra/realtime';
import {
  actualizarCobertura,
  cerrarEjecucionesVencidas,
  eventoProgramacion,
  eventosRelevo,
  publicarSeguro,
  type Evento,
} from '@modules/ejecuciones/ejecuciones.service';
import { fijarPlazosIncorporacion, vencerIncorporaciones } from '@modules/ejecuciones/incorporacion';
import { bloquearPunto, destinoDe } from '@modules/puntos-fijos/ocupacion';
import { APERTURA_ANTICIPADA_MIN, ZONA_HORARIA } from './config.js';
import { asignacionesAutomaticas } from './automatica.js';

// Planificador de horarios programados (F5).
//
// Corre en el SERVIDOR cada minuto, haya o no operadores conectados, y cada
// pasada hace tres cosas en este orden:
//  1. Cierra los horarios (y rutas) que terminaron: cubierta, cubierta a
//     medias o sin cubrir. Va primero para que el relevo de un punto fijo
//     no choque con el turno que ya terminó.
//  2. Abre los horarios que empiezan dentro de 15 min como ejecuciones
//     "pendientes", sin guardias, firmadas por el sistema. Tras un reinicio
//     recupera el que sigue en curso; los que terminaron con el servidor
//     caído solo quedan anotados en el registro (no se abren a destiempo).
//  3. F6: en los horarios AUTOMÁTICOS abiertos a los que les faltan
//     guardias, asigna a los libres más cercanos (automatica.ts) y, si siguen
//     faltando, reintenta cada 2 min hasta el fin del horario.
//  4. Inicia los horarios que llegaron a su hora: sus guardias asignados
//     con anticipación pasan a "en curso".
//
// Dos servidores a la vez no duplican nada: un horario se identifica por su
// ventana y su día local (índice único), el inicio bloquea la ejecución y el
// estado del planificador se lee con su fila bloqueada. El interruptor
// (`planificador_estado.habilitado`) deja de ABRIR horarios; los cierres siguen.

export interface Ocurrencia {
  programacion_id: string;
  ventana_id: string;
  /** Día LOCAL en que empieza el horario (YYYY-MM-DD). */
  fecha_local: string;
  inicio: Date;
  fin: Date;
  apertura: Date;
  cupo: number;
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona de las programaciones. */
export function diaLocal(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Horarios de las programaciones ACTIVAS entre dos fechas locales. Se
 * calculan en la BD con la zona horaria de cada programación: un turno que
 * cruza la medianoche pertenece al día en que empieza y termina en su
 * instante de fin; la ventana es [inicio, fin). Sin fechas de
 * vigencia: cuentan los horarios que terminan después de crearse el horario
 * (el que está en curso al crearlo, también).
 */
export async function ocurrencias(tx: Tx | typeof db, desde: string, hasta: string, filtro: Prisma.Sql = Prisma.empty): Promise<Ocurrencia[]> {
  return tx.$queryRaw<Ocurrencia[]>`
    SELECT o.programacion_id, o.ventana_id, o.fecha_local, o.cupo, o.inicio, o.fin,
           o.inicio - make_interval(mins => ${APERTURA_ANTICIPADA_MIN}::int) AS apertura FROM (
      SELECT p.id AS programacion_id, v.id AS ventana_id, v.created_at AS creada, to_char(d, 'YYYY-MM-DD') AS fecha_local, v.cupo::int AS cupo,
             (d::date + v.hora_inicio) AT TIME ZONE p.zona_horaria AS inicio,
             ((d::date + v.hora_inicio) AT TIME ZONE p.zona_horaria) + make_interval(mins => v.duracion_min) AS fin
      FROM ruta_programacion p
      JOIN ruta_programacion_ventana v ON v.programacion_id = p.id AND v.activo
      CROSS JOIN generate_series(${desde}::date, ${hasta}::date, interval '1 day') d
      WHERE p.estado = 'activa'
        AND extract(isodow FROM d)::smallint = ANY (v.dias)
        ${filtro}
    ) o
    WHERE o.fin > o.creada
    ORDER BY o.inicio, o.programacion_id`;
}

type ResultadoApertura = { estado: 'abierta'; evento: Evento } | { estado: 'ya_abierta' } | { estado: 'omitida'; motivo: string };

/** Abre UN horario como ejecución pendiente (sin guardias). Idempotente. */
async function abrirHorario(o: Ocurrencia, ahora: Date): Promise<ResultadoApertura> {
  return db.$transaction(async (tx) => {
    // FOR SHARE: espera a una edición, pausa o eliminación en curso y lee su resultado.
    await tx.$queryRaw`SELECT id FROM ruta_programacion WHERE id = ${o.programacion_id}::uuid FOR SHARE`;
    const p = await tx.rutaProgramacion.findUnique({ where: { id: o.programacion_id } });
    if (!p || p.estado !== 'activa') return { estado: 'omitida', motivo: 'programacion_inactiva' };
    const v = await tx.rutaProgramacionVentana.findUnique({ where: { id: o.ventana_id }, select: { activo: true } });
    if (!v?.activo) return { estado: 'omitida', motivo: 'horario_retirado' };
    let rutaPlantillaId: string | null = null;
    let puntoFijoId: string | null = null;
    let tipo = 'establecida';
    let trazado: string | null = null;
    let destino: string | null = null;
    if (p.puntoFijoId) {
      const pf = await tx.puntoFijo.findUnique({ where: { id: p.puntoFijoId } });
      if (!pf?.activo) return { estado: 'omitida', motivo: 'punto_inactivo' };
      // El Super Admin movió el punto a otra EPI: la programación ya no es de esta EPI.
      if (pf.epiId !== p.epiId) return { estado: 'omitida', motivo: 'punto_en_otra_epi' };
      puntoFijoId = pf.id;
      destino = JSON.stringify(destinoDe(pf));
    } else {
      const r = await tx.rutaPlantilla.findUnique({ where: { id: p.rutaPlantillaId! } });
      if (!r?.activo || !r.trazado) return { estado: 'omitida', motivo: 'ruta_archivada' };
      rutaPlantillaId = r.id;
      tipo = r.tipo ?? 'guardada';
      // Copia del trazado: editar la ruta después no cambia el horario ya abierto.
      trazado = JSON.stringify(r.trazado);
    }
    // Autoría: lo abre el SISTEMA en nombre de quien programó (persona real, nunca un id ficticio).
    const autor = p.actualizadoPorId ?? p.creadoPorId;
    // F6: copia del modo y del radio inicial (editar la programación no cambia este horario).
    // El primer intento automático es en esta misma pasada.
    const auto = p.modo === 'automatica';
    const [fila] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ruta_ejecucion (ruta_plantilla_id, epi_id, tipo, nombre, descripcion, modalidad, capacidad, trazado, origen, estado,
        inicio, fin, creado_por, creado_por_tipo, punto_fijo_id, destino, programacion_id, ventana_id, fecha_local, programacion_version, apertura,
        asignacion_modo, auto_radio_m, auto_proximo_intento)
      VALUES (${rutaPlantillaId}::uuid, ${p.epiId}::uuid, ${tipo}, ${p.nombre}, ${p.descripcion}, ${p.modalidad}, ${Math.min(50, o.cupo)}::smallint,
        ${trazado}::jsonb, 'programada', 'pendiente', ${o.inicio}, ${o.fin}, ${autor}::uuid, 'sistema', ${puntoFijoId}::uuid, ${destino}::jsonb,
        ${p.id}::uuid, ${o.ventana_id}::uuid, ${o.fecha_local}::date, ${p.version}, ${ahora},
        ${p.modo}, ${auto ? p.radioMaxM : null}::int, ${auto ? ahora : null}::timestamptz)
      ON CONFLICT (ventana_id, fecha_local) WHERE ventana_id IS NOT NULL DO NOTHING
      RETURNING id`;
    if (!fila) return { estado: 'ya_abierta' };
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorTipo: 'sistema',
        accion: 'abrir_horario',
        recurso: 'programacion',
        recursoId: fila.id,
        detalle: { programacionId: p.id, ventanaId: o.ventana_id, fechaLocal: o.fecha_local, inicio: o.inicio, fin: o.fin, programadoPor: autor, version: p.version, modo: p.modo },
      },
    });
    return {
      estado: 'abierta',
      evento: eventoProgramacion({ id: fila.id, epiId: p.epiId, programacionId: p.id, estado: 'pendiente', nombre: p.nombre }),
    };
  });
}

/** Inicia UN horario que llegó a su hora: sus guardias asignados con anticipación pasan a "en curso". */
async function iniciarHorario(id: string, puntoFijoId: string | null, ahora: Date): Promise<Evento[]> {
  return db.$transaction(async (tx) => {
    // Mismo orden de bloqueo que el motor: raíz del punto, luego la ejecución.
    if (puntoFijoId) await bloquearPunto(tx, puntoFijoId);
    const [fila] = await tx.$queryRaw<{ estado: string }[]>`SELECT estado FROM ruta_ejecucion WHERE id = ${id}::uuid FOR UPDATE`;
    if (fila?.estado !== 'pendiente') return [];
    const previas = await tx.patrulla.findMany({ where: { ejecucionId: id, estado: 'asignada' }, select: { id: true, guardiaId: true } });
    if (previas.length === 0) return [];
    await tx.patrulla.updateMany({
      where: { id: { in: previas.map((p) => p.id) }, estado: 'asignada' },
      data: { estado: 'en_curso', iniciadaEn: ahora, estadoRuta: 'incorporandose', estadoRutaEn: ahora },
    });
    await fijarPlazosIncorporacion(tx, previas.map((p) => p.id), ahora);
    const cobertura = await actualizarCobertura(tx, id, ahora);
    const e = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id } });
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorTipo: 'sistema',
        accion: 'iniciar_horario',
        recurso: 'programacion',
        recursoId: id,
        detalle: { programacionId: e.programacionId, guardias: previas.map((p) => p.guardiaId), estado: e.estado, relevos: cobertura?.relevos ?? [] } as unknown as Prisma.InputJsonValue,
      },
    });
    return [
      ...eventosRelevo(cobertura?.relevos ?? []),
      {
        tipo: EVENTS.patrullaAsignada,
        epiId: e.epiId,
        payload: { ejecucionId: id, epiId: e.epiId, guardiaIds: previas.map((p) => p.guardiaId), patrullaIds: previas.map((p) => p.id), puntoFijoId: e.puntoFijoId },
      },
      eventoProgramacion(e),
    ];
  });
}

export interface ResumenPasada {
  habilitado: boolean;
  abiertas: number;
  iniciadas: number;
  cerradas: number;
  perdidas: number;
  omitidas: number;
  errores: number;
  /** F6: intentos automáticos hechos y guardias asignados por ellos. */
  intentosAuto: number;
  asignadosAuto: number;
  /** F7: guardias que vencieron su plazo para incorporarse (pasan a advertencia/alerta). */
  fueraDePlazo: number;
}

/**
 * Una pasada del planificador. `ahora` se puede fijar (pruebas: turnos
 * nocturnos, 24 h, reinicios); en producción es la hora del servidor.
 */
export async function pasadaPlanificador(ahora = new Date()): Promise<ResumenPasada> {
  const inicioPasada = new Date();
  const r: ResumenPasada = { habilitado: true, abiertas: 0, iniciadas: 0, cerradas: 0, perdidas: 0, omitidas: 0, errores: 0, intentosAuto: 0, asignadosAuto: 0, fueraDePlazo: 0 };
  const detalle: { abiertas: unknown[]; perdidas: unknown[]; omitidas: unknown[]; errores: unknown[]; automaticas: unknown[] } = { abiertas: [], perdidas: [], omitidas: [], errores: [], automaticas: [] };
  const fallo = (fase: string, err: unknown, extra: Record<string, unknown> = {}) => {
    r.errores++;
    detalle.errores.push({ fase, ...extra, error: err instanceof Error ? err.message : String(err) });
  };

  // 1) Cierres (siempre, aunque el planificador esté pausado).
  try {
    r.cerradas = await cerrarEjecucionesVencidas(ahora);
  } catch (err) {
    fallo('cerrar', err);
  }
  // 1b) F7: plazos de incorporación vencidos (siempre: no es parte de la programación).
  try {
    r.fueraDePlazo = await vencerIncorporaciones(ahora);
  } catch (err) {
    fallo('incorporacion', err);
  }

  // 2) Interruptor y última pasada, con la fila bloqueada: así dos servidores
  //    no anotan dos veces el mismo horario perdido.
  const { habilitado, desde } = await db.$transaction(async (tx) => {
    const [e] = await tx.$queryRaw<{ habilitado: boolean; ultima_pasada: Date | null }[]>`
      SELECT habilitado, ultima_pasada FROM planificador_estado WHERE id = 1 FOR UPDATE`;
    await tx.$executeRaw`UPDATE planificador_estado SET ultima_pasada = ${ahora}
      WHERE id = 1 AND (ultima_pasada IS NULL OR ultima_pasada < ${ahora})`;
    return { habilitado: e?.habilitado ?? true, desde: e?.ultima_pasada ?? null };
  });
  r.habilitado = habilitado;
  /** Primera pasada que "ve" este horario (para anotarlo una sola vez). */
  const recien = (o: Ocurrencia) => !desde || o.apertura > desde;

  // 3) Abrir. Se mira de ayer a mañana: cubre turnos nocturnos y de 24 h.
  const hoy = diaLocal(ahora);
  const lista = await ocurrencias(db, sumarDias(hoy, -1), sumarDias(hoy, 1));
  const abiertas = new Set(
    (
      await db.rutaEjecucion.findMany({
        where: { ventanaId: { in: [...new Set(lista.map((o) => o.ventana_id))] } },
        select: { ventanaId: true, fechaLocal: true },
      })
    ).map((e) => `${e.ventanaId}|${e.fechaLocal!.toISOString().slice(0, 10)}`),
  );
  const eventos: Evento[] = [];
  for (const o of lista) {
    if (o.apertura > ahora || abiertas.has(`${o.ventana_id}|${o.fecha_local}`)) continue;
    const info = { programacionId: o.programacion_id, ventanaId: o.ventana_id, fechaLocal: o.fecha_local, inicio: o.inicio, fin: o.fin };
    if (!habilitado) {
      if (recien(o)) {
        r.omitidas++;
        detalle.omitidas.push({ ...info, motivo: 'planificador_pausado' });
      }
      continue;
    }
    if (o.fin <= ahora) {
      // Terminó sin abrirse (servidor caído): solo se anota, no se abre a destiempo.
      if (recien(o)) {
        r.perdidas++;
        detalle.perdidas.push(info);
      }
      continue;
    }
    try {
      const res = await abrirHorario(o, ahora);
      if (res.estado === 'abierta') {
        r.abiertas++;
        detalle.abiertas.push(info);
        eventos.push(res.evento);
      } else if (res.estado === 'omitida' && recien(o)) {
        r.omitidas++;
        detalle.omitidas.push({ ...info, motivo: res.motivo });
      }
    } catch (err) {
      fallo('abrir', err, info);
    }
  }

  // 3b) F6: asignación automática (no corre con el planificador pausado: es una activación).
  if (habilitado) {
    try {
      for (const a of await asignacionesAutomaticas(ahora)) {
        r.intentosAuto++;
        r.asignadosAuto += a.asignados;
        detalle.automaticas.push(a);
        if (a.error) fallo('automatica', a.error, { ejecucionId: a.ejecucionId });
      }
    } catch (err) {
      fallo('automatica', err);
    }
  }

  // 4) Iniciar los horarios que llegaron a su hora con guardias ya asignados.
  const porIniciar = await db.rutaEjecucion.findMany({
    where: { programacionId: { not: null }, estado: 'pendiente', inicio: { lte: ahora }, fin: { gt: ahora }, patrullas: { some: { estado: 'asignada' } } },
    select: { id: true, puntoFijoId: true },
  });
  for (const e of porIniciar) {
    try {
      const ev = await iniciarHorario(e.id, e.puntoFijoId, ahora);
      if (ev.length > 0) {
        r.iniciadas++;
        eventos.push(...ev);
      }
    } catch (err) {
      fallo('iniciar', err, { ejecucionId: e.id });
    }
  }
  publicarSeguro(eventos);

  // 5) Estado y registro (solo las pasadas con algo que contar).
  const ultimoError = r.errores > 0 ? JSON.stringify(detalle.errores[0]).slice(0, 500) : null;
  await db.$executeRaw`UPDATE planificador_estado SET
      ultima_pasada_ok = CASE WHEN ${r.errores}::int = 0 THEN ${ahora} ELSE ultima_pasada_ok END,
      ultimo_error = CASE WHEN ${r.errores}::int = 0 THEN ultimo_error ELSE ${ultimoError} END
    WHERE id = 1`;
  // Un reintento automático sin novedad no deja fila (solo los que asignan o fallan).
  if (r.abiertas + r.iniciadas + r.cerradas + r.perdidas + r.omitidas + r.errores + r.asignadosAuto > 0) {
    await db.planificadorRegistro.create({
      data: {
        inicio: inicioPasada,
        fin: new Date(),
        abiertas: r.abiertas,
        iniciadas: r.iniciadas,
        cerradas: r.cerradas,
        perdidas: r.perdidas,
        omitidas: r.omitidas,
        errores: r.errores,
        detalle: { ahora, ...detalle } as Prisma.InputJsonValue,
      },
    });
  }
  return r;
}
