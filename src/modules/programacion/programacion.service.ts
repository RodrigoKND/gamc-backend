import { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS } from '@infra/realtime';
import { epiDeAlcance, exigirMismaEpi, type Alcance, type Jurisdiccion } from '@modules/mapas/jurisdiccion';
import { cancelarEnTransaccion, publicarSeguro, type Evento } from '@modules/ejecuciones/ejecuciones.service';
import { CAPACIDAD_MAX, type Modalidad } from '@modules/ejecuciones/config';
import { capacidadEfectiva } from '@modules/puntos-fijos/ocupacion';
import { AGENDA_DIAS_MAX, APERTURA_ANTICIPADA_MIN, AUTO_RADIO_INICIAL_M, AUTO_REINTENTO_MIN, DIAS_SEMANA, PLANIFICADOR_INTERVALO_MS, ZONA_HORARIA } from './config.js';
import { diaLocal, ocurrencias, sumarDias } from './planificador.js';

// Programación manual de rutas (F5). Se programa una ruta de la biblioteca
// (predeterminada o guardada) o un punto fijo con uno o más horarios; el
// planificador abre cada horario y el operador le asigna los guardias.
// Permiso `programacion_rutas`: el Operador programa en su EPI, el Super
// Admin en todas; el Admin solo ve. Todo queda segmentado por EPI (F3).
//
// Editar vale para los horarios FUTUROS: los ya abiertos guardan su copia
// (cupo, nombre, trazado). Cambiar días, hora o duración de un horario crea
// uno nuevo y retira el anterior (no se borra: las ejecuciones lo citan).
//
// Sin fechas de vigencia (pedido del usuario): una programación funciona
// desde que se crea mientras esté activa; se pausa o se elimina. Eliminar es
// lógico (estado `archivada`): sale de la lista y de la agenda, cancela el
// horario abierto y conserva el historial. Dos horarios del mismo punto o de
// la misma ruta no pueden cruzarse (el que empieza relevaría al otro).
//
// F6: una programación puede ser MANUAL (el operador asigna) o AUTOMÁTICA
// (el sistema asigna a los guardias libres más cercanos; el radio de
// búsqueda lo maneja el sistema: 3 km que crecen solos). El modo se copia en
// cada horario al abrirlo: cambiarlo vale para los horarios siguientes. Si un
// operador elige a mano un reemplazo, la automática le espera y luego sigue
// (reanudarAutomatica).

export interface ActorProgramacion {
  id: string;
  role: string;
  permissions: Record<string, { ver?: boolean; crear?: boolean; editar?: boolean; eliminar?: boolean } | undefined>;
}

function exigirPermiso(actor: ActorProgramacion, accion: 'crear' | 'editar' | 'eliminar') {
  if (!actor.permissions.programacion_rutas?.[accion]) {
    const que = { crear: 'programar', editar: 'editar programaciones de', eliminar: 'eliminar programaciones de' }[accion];
    throw Errors.forbidden(`Tu rol no puede ${que} rutas.`);
  }
}

export interface VentanaInput {
  id?: string;
  /** 1 = lunes … 7 = domingo. */
  dias: number[];
  /** HH:MM, hora de Bolivia. */
  horaInicio: string;
  duracionMin: number;
  cupo: number;
}

export interface CrearProgramacionInput {
  nombre?: string | null;
  descripcion?: string | null;
  rutaPlantillaId?: string;
  puntoFijoId?: string;
  origen?: 'manual' | 'prueba';
  modo?: ModoAsignacion;
  ventanas: VentanaInput[];
}

export type ModoAsignacion = 'manual' | 'automatica';

export interface EditarProgramacionInput {
  nombre?: string;
  descripcion?: string | null;
  estado?: 'activa' | 'pausada';
  modo?: ModoAsignacion;
  ventanas?: VentanaInput[];
}

export interface VentanaDto {
  id: string;
  dias: number[];
  horaInicio: string;
  horaFin: string;
  duracionMin: number;
  /** Termina al día siguiente (turno nocturno o de 24 h). */
  cruzaMedianoche: boolean;
  cupo: number;
}

export interface ProgramacionDto {
  id: string;
  nombre: string;
  descripcion: string | null;
  epiId: string;
  epiCodigo: string | null;
  epiNombre: string | null;
  objetivo: { tipo: 'ruta' | 'punto'; id: string; nombre: string; activo: boolean };
  modalidad: string;
  /** Máximo de guardias por horario (el de la modalidad, o la capacidad del punto). */
  cupoMax: number;
  /** F6: manual (el operador asigna) o automática (el sistema asigna). */
  modo: ModoAsignacion;
  radioMaxM: number | null;
  estado: string;
  origen: string;
  version: number;
  creadoPor: string | null;
  actualizadoEn: Date;
  ventanas: VentanaDto[];
  /** Próximo horario (o el que está en curso). */
  proximo: { inicio: Date; fin: Date } | null;
}

const fecha = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const aHora = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const deHora = (d: Date) => d.toISOString().slice(11, 16);

function horaFin(inicio: string, duracionMin: number) {
  const [h, m] = inicio.split(':').map(Number);
  const total = h! * 60 + m! + duracionMin;
  const fin = total % 1440;
  return { horaFin: `${String(Math.floor(fin / 60)).padStart(2, '0')}:${String(fin % 60).padStart(2, '0')}`, cruzaMedianoche: total > 1440 || duracionMin === 1440 };
}

function ventanaDto(v: { id: string; dias: number[]; horaInicio: Date; duracionMin: number; cupo: number }): VentanaDto {
  const inicio = deHora(v.horaInicio);
  return { id: v.id, dias: [...v.dias].sort(), horaInicio: inicio, duracionMin: v.duracionMin, cupo: v.cupo, ...horaFin(inicio, v.duracionMin) };
}

interface Objetivo {
  epiId: string;
  modalidad: Modalidad;
  cupoMax: number;
  nombre: string;
  rutaPlantillaId: string | null;
  puntoFijoId: string | null;
}

/** Qué se programa: ruta de la biblioteca (no dinámica) o punto fijo (el punto completo). */
async function resolverObjetivo(tx: Tx, input: { rutaPlantillaId?: string | null; puntoFijoId?: string | null }, j: Jurisdiccion | null): Promise<Objetivo> {
  if (input.rutaPlantillaId) {
    const r = await tx.rutaPlantilla.findUnique({ where: { id: input.rutaPlantillaId } });
    if (!r) throw Errors.notFound('La ruta no existe.');
    if (!r.activo || r.tipo === 'dinamica') throw Errors.validation('Solo se programan rutas predeterminadas o guardadas (no archivadas).');
    if (!r.epiId || !r.trazado) throw Errors.validation('La ruta no tiene EPI o trazado: edítala antes de programarla.');
    exigirMismaEpi(j, r.epiId, 'La ruta');
    const modalidad = (r.modalidad ?? 'coche') as Modalidad;
    const max = CAPACIDAD_MAX[modalidad] ?? CAPACIDAD_MAX.coche;
    return { epiId: r.epiId, modalidad, cupoMax: max, nombre: r.nombre, rutaPlantillaId: r.id, puntoFijoId: null };
  }
  const pf = await tx.puntoFijo.findUnique({ where: { id: input.puntoFijoId! }, include: { subpuntos: true } });
  if (!pf) throw Errors.notFound('El punto fijo no existe.');
  if (pf.padreId) throw Errors.validation('Programa el punto completo; el subpunto de cada guardia se elige al asignar.');
  if (!pf.activo) throw Errors.validation('El punto fijo está desactivado.');
  exigirMismaEpi(j, pf.epiId, 'El punto fijo');
  return { epiId: pf.epiId, modalidad: 'punto_fijo', cupoMax: capacidadEfectiva(pf, pf.subpuntos), nombre: pf.nombre, rutaPlantillaId: null, puntoFijoId: pf.id };
}

/** Automática: el radio inicial lo fija el sistema (3 km: nunca "cualquier distancia"). */
function parametrosAsignacion(modo: ModoAsignacion) {
  return { modo, radioMaxM: modo === 'automatica' ? AUTO_RADIO_INICIAL_M : null };
}

function validarVentanas(ventanas: VentanaInput[], cupoMax: number) {
  if (ventanas.length === 0) throw Errors.validation('Agrega al menos un horario.');
  ventanas.forEach((v, i) => {
    if (new Set(v.dias).size !== v.dias.length) throw Errors.validation(`El horario ${i + 1} repite un día.`);
    if (v.cupo > cupoMax) throw Errors.validation(`El horario ${i + 1} pide ${v.cupo} guardias; esta ruta o punto admite hasta ${cupoMax}.`);
  });
}

// --- Horarios que se cruzan ---------------------------------------------------

const SEMANA_MIN = 7 * 1440;
const DIA_CORTO = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** Tramos [inicio, fin) del horario en minutos de la semana (lunes 00:00 = 0). El domingo nocturno sigue el lunes. */
function tramos(v: { dias: number[]; horaInicio: string; duracionMin: number }): [number, number][] {
  const [h, m] = v.horaInicio.split(':').map(Number);
  return v.dias.flatMap((d): [number, number][] => {
    const ini = (d - 1) * 1440 + h! * 60 + m!;
    const fin = ini + v.duracionMin;
    return fin <= SEMANA_MIN ? [[ini, fin]] : [[ini, SEMANA_MIN], [0, fin - SEMANA_MIN]];
  });
}

/** Se cruzan si comparten algún minuto (uno que termina justo cuando empieza el otro, no). */
function seCruzan(a: VentanaInput, b: VentanaInput) {
  const tb = tramos(b);
  return tramos(a).some(([ai, af]) => tb.some(([bi, bf]) => ai < bf && bi < af));
}

function textoHorario(v: VentanaInput) {
  const dias = v.dias.length === DIAS_SEMANA.length ? 'todos los días' : [...v.dias].sort().map((d) => DIA_CORTO[d - 1]).join(', ');
  return `${dias} ${v.horaInicio}–${horaFin(v.horaInicio, v.duracionMin).horaFin}`;
}

/**
 * Rechaza horarios que se cruzan entre sí o con los de otra programación
 * (activa o pausada) del mismo punto o de la misma ruta. Bloquea la fila del
 * punto/ruta: dos operadores no guardan a la vez dos horarios que chocan.
 */
async function validarCruces(tx: Tx, obj: Pick<Objetivo, 'rutaPlantillaId' | 'puntoFijoId'>, ventanas: VentanaInput[], excluirId?: string) {
  for (let i = 0; i < ventanas.length; i++) {
    for (let k = i + 1; k < ventanas.length; k++) {
      if (seCruzan(ventanas[i]!, ventanas[k]!)) throw Errors.validation(`Los horarios ${i + 1} y ${k + 1} se cruzan.`);
    }
  }
  if (obj.puntoFijoId) await tx.$queryRaw`SELECT id FROM punto_fijo WHERE id = ${obj.puntoFijoId}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM ruta_plantilla WHERE id = ${obj.rutaPlantillaId}::uuid FOR UPDATE`;
  const otras = await tx.rutaProgramacion.findMany({
    where: {
      ...(obj.puntoFijoId ? { puntoFijoId: obj.puntoFijoId } : { rutaPlantillaId: obj.rutaPlantillaId }),
      estado: { in: ['activa', 'pausada'] },
      ...(excluirId ? { id: { not: excluirId } } : {}),
    },
    include: { ventanas: { where: { activo: true } } },
  });
  for (const otra of otras) {
    for (const ov of otra.ventanas) {
      const suya: VentanaInput = { dias: ov.dias, horaInicio: deHora(ov.horaInicio), duracionMin: ov.duracionMin, cupo: ov.cupo };
      const choca = ventanas.findIndex((v) => seCruzan(v, suya));
      if (choca >= 0) {
        const que = obj.puntoFijoId ? 'del mismo punto' : 'de la misma ruta';
        throw Errors.validation(
          `${ventanas.length > 1 ? `El horario ${choca + 1}` : 'El horario'} se cruza con «${otra.nombre}» (${textoHorario(suya)}${otra.estado === 'pausada' ? ', pausada' : ''}). Dos horarios ${que} no pueden cruzarse.`,
        );
      }
    }
  }
}

const mismoHorario = (a: { dias: number[]; horaInicio: Date; duracionMin: number }, b: VentanaInput) =>
  [...a.dias].sort().join(',') === [...b.dias].sort().join(',') && deHora(a.horaInicio) === b.horaInicio && a.duracionMin === b.duracionMin;

const incluir = { ventanas: { where: { activo: true }, orderBy: [{ orden: 'asc' as const }, { horaInicio: 'asc' as const }] } };
type FilaProgramacion = Prisma.RutaProgramacionGetPayload<{ include: typeof incluir }>;

async function aDtos(filas: FilaProgramacion[], ahora = new Date()): Promise<ProgramacionDto[]> {
  if (filas.length === 0) return [];
  const [epis, rutas, puntos, usuarios] = await Promise.all([
    db.epi.findMany({ select: { id: true, codigo: true, nombre: true } }),
    db.rutaPlantilla.findMany({ where: { id: { in: filas.flatMap((f) => (f.rutaPlantillaId ? [f.rutaPlantillaId] : [])) } }, select: { id: true, nombre: true, activo: true, modalidad: true } }),
    db.puntoFijo.findMany({ where: { id: { in: filas.flatMap((f) => (f.puntoFijoId ? [f.puntoFijoId] : [])) } }, include: { subpuntos: true } }),
    db.user.findMany({ where: { id: { in: filas.flatMap((f) => (f.creadoPorId ? [f.creadoPorId] : [])) } } }),
  ]);
  const epiPor = new Map(epis.map((e) => [e.id, e]));
  const rutaPor = new Map(rutas.map((r) => [r.id, r]));
  const puntoPor = new Map(puntos.map((p) => [p.id, p]));
  const usuarioPor = new Map(usuarios.map((u) => [u.id, nombreCompleto(u)]));
  // Próximo horario de cada una (o el que sigue en curso), en los próximos 8 días.
  const hoy = diaLocal(ahora);
  const ids = filas.map((f) => f.id);
  const proximos = new Map<string, { inicio: Date; fin: Date }>();
  // Un horario ya cerrado o cancelado (aunque su hora no haya terminado) no es el "próximo".
  const cerrados = await db.rutaEjecucion.findMany({
    where: { programacionId: { in: ids }, estado: { in: ['finalizada', 'cancelada'] }, fin: { gt: ahora } },
    select: { ventanaId: true, fechaLocal: true },
  });
  const yaCerrado = new Set(cerrados.map((e) => `${e.ventanaId}|${fecha(e.fechaLocal)}`));
  for (const o of await ocurrencias(db, sumarDias(hoy, -1), sumarDias(hoy, 7), Prisma.sql`AND p.id = ANY(${ids}::uuid[])`)) {
    if (o.fin <= ahora || yaCerrado.has(`${o.ventana_id}|${o.fecha_local}`) || proximos.has(o.programacion_id)) continue;
    proximos.set(o.programacion_id, { inicio: o.inicio, fin: o.fin });
  }
  return filas.map((f) => {
    const ruta = f.rutaPlantillaId ? rutaPor.get(f.rutaPlantillaId) : null;
    const punto = f.puntoFijoId ? puntoPor.get(f.puntoFijoId) : null;
    const modalidad = f.modalidad as Modalidad;
    const max = CAPACIDAD_MAX[modalidad] ?? CAPACIDAD_MAX.coche;
    return {
      id: f.id,
      nombre: f.nombre,
      descripcion: f.descripcion,
      epiId: f.epiId,
      epiCodigo: epiPor.get(f.epiId)?.codigo ?? null,
      epiNombre: epiPor.get(f.epiId)?.nombre ?? null,
      objetivo: punto
        ? { tipo: 'punto', id: punto.id, nombre: punto.nombre, activo: punto.activo }
        : { tipo: 'ruta', id: f.rutaPlantillaId!, nombre: ruta?.nombre ?? 'Ruta', activo: Boolean(ruta?.activo) },
      modalidad: f.modalidad,
      cupoMax: punto ? capacidadEfectiva(punto, punto.subpuntos) : max,
      modo: f.modo as ModoAsignacion,
      radioMaxM: f.radioMaxM,
      estado: f.estado,
      origen: f.origen,
      version: f.version,
      creadoPor: f.creadoPorId ? (usuarioPor.get(f.creadoPorId) ?? null) : null,
      actualizadoEn: f.updatedAt,
      ventanas: f.ventanas.map(ventanaDto),
      proximo: f.estado === 'activa' ? (proximos.get(f.id) ?? null) : null,
    };
  });
}

export async function listarProgramaciones(alcance: Alcance, op: { incluirArchivadas?: boolean } = {}): Promise<ProgramacionDto[]> {
  const epi = epiDeAlcance(alcance);
  const filas = await db.rutaProgramacion.findMany({
    where: { ...(epi ? { epiId: epi } : {}), ...(op.incluirArchivadas ? {} : { estado: { not: 'archivada' } }) },
    include: incluir,
    // Activas primero; las pausadas, al final de la lista.
    orderBy: [{ estado: 'asc' }, { nombre: 'asc' }],
  });
  return aDtos(filas);
}

function eventoDe(p: { id: string; epiId: string; estado: string; nombre: string }) {
  return { tipo: EVENTS.programacionActualizada, epiId: p.epiId, payload: { programacionId: p.id, estado: p.estado, nombre: p.nombre } };
}

export async function crearProgramacion(input: CrearProgramacionInput, actor: ActorProgramacion, j: Jurisdiccion | null): Promise<ProgramacionDto> {
  exigirPermiso(actor, 'crear');
  if (Boolean(input.rutaPlantillaId) === Boolean(input.puntoFijoId)) throw Errors.validation('Elige UNA ruta o UN punto fijo para programar.');
  const p = await db.$transaction(async (tx) => {
    const obj = await resolverObjetivo(tx, input, j);
    validarVentanas(input.ventanas, obj.cupoMax);
    await validarCruces(tx, obj, input.ventanas);
    const asignacion = parametrosAsignacion(input.modo ?? 'manual');
    const creada = await tx.rutaProgramacion.create({
      data: {
        nombre: input.nombre?.trim() || obj.nombre,
        descripcion: input.descripcion ?? null,
        epiId: obj.epiId,
        rutaPlantillaId: obj.rutaPlantillaId,
        puntoFijoId: obj.puntoFijoId,
        modalidad: obj.modalidad,
        // Sin vigencia: la columna queda con el día de creación (informativa).
        vigenciaDesde: new Date(`${diaLocal(new Date())}T00:00:00.000Z`),
        vigenciaHasta: null,
        zonaHoraria: ZONA_HORARIA,
        origen: input.origen ?? 'manual',
        modo: asignacion.modo,
        radioMaxM: asignacion.radioMaxM,
        creadoPorId: actor.id,
        actualizadoPorId: actor.id,
        ventanas: {
          create: input.ventanas.map((v, i) => ({ dias: [...v.dias].sort(), horaInicio: aHora(v.horaInicio), duracionMin: v.duracionMin, cupo: v.cupo, orden: i })),
        },
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: actor.id,
        accion: 'crear_programacion',
        recurso: 'programacion_rutas',
        recursoId: creada.id,
        detalle: { nombre: creada.nombre, rutaPlantillaId: obj.rutaPlantillaId, puntoFijoId: obj.puntoFijoId, ventanas: input.ventanas, modo: creada.modo, radioMaxM: creada.radioMaxM } as unknown as Prisma.InputJsonValue,
      },
    });
    return creada;
  });
  publicarSeguro([eventoDe(p)]);
  const [dto] = await aDtos([await db.rutaProgramacion.findUniqueOrThrow({ where: { id: p.id }, include: incluir })]);
  return dto!;
}

/** Bloquea la programación y comprueba jurisdicción (FOR UPDATE: dos ediciones no se pisan). */
async function bloquearProgramacion(tx: Tx, id: string, j: Jurisdiccion | null) {
  const [fila] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM ruta_programacion WHERE id = ${id}::uuid FOR UPDATE`;
  if (!fila) throw Errors.notFound('La programación no existe.');
  const p = await tx.rutaProgramacion.findUniqueOrThrow({ where: { id }, include: { ventanas: { where: { activo: true } } } });
  exigirMismaEpi(j, p.epiId, 'La programación');
  return p;
}

export async function actualizarProgramacion(id: string, patch: EditarProgramacionInput, actor: ActorProgramacion, j: Jurisdiccion | null): Promise<ProgramacionDto> {
  exigirPermiso(actor, 'editar');
  const p = await db.$transaction(async (tx) => {
    const p = await bloquearProgramacion(tx, id, j);
    if (p.estado === 'archivada') throw Errors.conflict('La programación fue eliminada.');
    if (patch.estado === 'activa' || patch.ventanas) {
      // Reanudar o cambiar horarios exige que la ruta/punto siga disponible (y el cupo, dentro de su capacidad).
      const obj = await resolverObjetivo(tx, p, j);
      if (patch.ventanas) {
        validarVentanas(patch.ventanas, obj.cupoMax);
        await validarCruces(tx, obj, patch.ventanas, id);
      }
    }
    const cambios: Record<string, unknown> = {};
    if (patch.ventanas) {
      const actuales = new Map(p.ventanas.map((v) => [v.id, v]));
      const recibidas = new Set(patch.ventanas.flatMap((v) => (v.id ? [v.id] : [])));
      for (const vid of recibidas) if (!actuales.has(vid)) throw Errors.validation('Uno de los horarios ya no existe. Vuelve a abrir la programación.');
      const retiradas = p.ventanas.filter((v) => !recibidas.has(v.id)).map((v) => v.id);
      let orden = 0;
      for (const v of patch.ventanas) {
        const previa = v.id ? actuales.get(v.id) : undefined;
        if (previa && mismoHorario(previa, v)) {
          // Solo cupo u orden: el mismo horario sigue (no se reabre el de hoy).
          if (previa.cupo !== v.cupo || previa.orden !== orden) {
            await tx.rutaProgramacionVentana.update({ where: { id: previa.id }, data: { cupo: v.cupo, orden, updatedAt: new Date() } });
          }
        } else {
          // Horario nuevo o cambiado (días, hora o duración): identidad nueva.
          if (previa) retiradas.push(previa.id);
          await tx.rutaProgramacionVentana.create({
            data: { programacionId: id, dias: [...v.dias].sort(), horaInicio: aHora(v.horaInicio), duracionMin: v.duracionMin, cupo: v.cupo, orden },
          });
        }
        orden++;
      }
      if (retiradas.length > 0) {
        await tx.rutaProgramacionVentana.updateMany({ where: { id: { in: retiradas } }, data: { activo: false, updatedAt: new Date() } });
      }
      cambios.ventanas = { antes: p.ventanas.map(ventanaDto), despues: patch.ventanas };
    }
    const data: Prisma.RutaProgramacionUpdateInput = {
      version: { increment: 1 },
      actualizadoPorId: actor.id,
      updatedAt: new Date(),
    };
    if (patch.nombre !== undefined) data.nombre = patch.nombre.trim();
    if (patch.descripcion !== undefined) data.descripcion = patch.descripcion;
    if (patch.estado !== undefined) data.estado = patch.estado;
    if (patch.modo !== undefined) {
      const a = parametrosAsignacion(patch.modo);
      data.modo = a.modo;
      data.radioMaxM = a.radioMaxM;
    }
    const actualizada = await tx.rutaProgramacion.update({ where: { id }, data });
    const { ventanas: _v, ...resto } = patch;
    await tx.auditLog.create({
      data: {
        actorUserId: actor.id,
        accion: patch.estado && patch.estado !== p.estado ? (patch.estado === 'pausada' ? 'pausar_programacion' : 'reanudar_programacion') : 'editar_programacion',
        recurso: 'programacion_rutas',
        recursoId: id,
        detalle: { version: actualizada.version, ...resto, ...cambios } as unknown as Prisma.InputJsonValue,
      },
    });
    return actualizada;
  });
  publicarSeguro([eventoDe(p)]);
  const [dto] = await aDtos([await db.rutaProgramacion.findUniqueOrThrow({ where: { id }, include: incluir })]);
  return dto!;
}

/**
 * Elimina una programación (borrado lógico: estado `archivada`). Deja de
 * abrir horarios y cancela el que esté abierto (sus guardias quedan libres);
 * los horarios ya cerrados se conservan para el historial.
 */
export async function eliminarProgramacion(id: string, actor: ActorProgramacion, j: Jurisdiccion | null) {
  exigirPermiso(actor, 'eliminar');
  const res = await db.$transaction(async (tx) => {
    const p = await bloquearProgramacion(tx, id, j);
    if (p.estado === 'archivada') return { p, cancelados: 0, eventos: [] as Evento[] };
    const r = await tx.rutaProgramacion.update({ where: { id }, data: { estado: 'archivada', version: { increment: 1 }, actualizadoPorId: actor.id, updatedAt: new Date() } });
    const abiertas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM ruta_ejecucion WHERE programacion_id = ${id}::uuid AND estado IN ('pendiente', 'incompleta', 'activa') ORDER BY id FOR UPDATE`;
    const eventos: Evento[] = [];
    let cancelados = 0;
    for (const e of abiertas) {
      const c = await cancelarEnTransaccion(tx, e.id, actor.id, 'programacion_eliminada');
      cancelados += c.cancelados;
      eventos.push(...c.eventos);
    }
    await tx.auditLog.create({
      data: { actorUserId: actor.id, accion: 'eliminar_programacion', recurso: 'programacion_rutas', recursoId: id, detalle: { nombre: p.nombre, horariosCancelados: abiertas.map((e) => e.id), guardiasLiberados: cancelados } },
    });
    return { p: r, cancelados, eventos };
  });
  publicarSeguro([...res.eventos, eventoDe(res.p)]);
  return { id, estado: 'eliminada', guardiasLiberados: res.cancelados };
}

// --- Agenda y avisos ----------------------------------------------------------

export interface GuardiaHorario {
  patrullaId: string;
  guardiaId: string;
  guardiaNombre: string;
  estado: string;
  puntoFijoId: string | null;
}

export interface HorarioAgenda {
  /** Identidad estable del horario: ventana + día local. */
  clave: string;
  ejecucionId: string | null;
  programacionId: string;
  ventanaId: string;
  nombre: string;
  epiCodigo: string | null;
  modalidad: string;
  rutaPlantillaId: string | null;
  puntoFijoId: string | null;
  fechaLocal: string;
  inicio: Date;
  fin: Date;
  apertura: Date;
  cupo: number;
  /**
   * Estado del horario: `programada` (aún no se abre), `por_abrir` (debió
   * abrirse: planificador pausado o en su próxima pasada), `no_abierta`
   * (terminó sin abrirse) o el de su ejecución: pendiente / incompleta /
   * activa / finalizada / cancelada.
   */
  estado: string;
  /** Al cerrar: cubierta / cubierta_parcial / sin_cubrir / cancelada_por_usuario… */
  motivoCierre: string | null;
  /** Guardias asignados ahora (en curso, o asignados antes del inicio). */
  asignados: number;
  /** Guardias que llegaron a estar en servicio en este horario. */
  atendieron: number;
  guardias: GuardiaHorario[];
  /** F6: modo del horario (copia de la programación al abrirlo, o el actual si aún no se abre). */
  asignacionModo: ModoAsignacion;
  automatica: EstadoAutomatica | null;
}

/** Cómo va la asignación automática de un horario (para la agenda y la campana). */
export interface EstadoAutomatica {
  /** Radio de búsqueda actual (empieza en 3 km y crece solo). */
  radioM: number | null;
  intentos: number;
  proximoIntento: Date | null;
  /** Un operador está eligiendo a mano al reemplazo: la automática espera hasta esta hora. */
  reservaHasta: Date | null;
  ultimo: {
    en: Date;
    asignados: number;
    faltan: number;
    candidatos: number;
    radioM?: number;
    elegidos: { guardiaId: string; nombre: string; distanciaM: number | null }[];
    descartes: Record<string, number>;
    error?: string;
  } | null;
}

function estadoAutomatica(e: {
  asignacionModo: string | null;
  autoRadioM: number | null;
  autoIntentos: number;
  autoProximoIntento: Date | null;
  autoUltimo: Prisma.JsonValue;
  estado: string;
}): EstadoAutomatica | null {
  if (e.asignacionModo !== 'automatica') return null;
  const abierto = ['pendiente', 'incompleta', 'activa'].includes(e.estado);
  const reserva = (e.autoUltimo as { reservaHasta?: string } | null)?.reservaHasta;
  return {
    radioM: e.autoRadioM,
    intentos: e.autoIntentos,
    proximoIntento: abierto ? e.autoProximoIntento : null,
    reservaHasta: abierto && reserva && new Date(reserva) > new Date() ? new Date(reserva) : null,
    ultimo: (e.autoUltimo as EstadoAutomatica['ultimo']) ?? null,
  };
}

/** Agenda de las programaciones del alcance entre dos fechas locales (por defecto hoy y mañana). */
export async function agenda(alcance: Alcance, op: { desde?: string; hasta?: string } = {}, ahora = new Date()): Promise<HorarioAgenda[]> {
  const desde = op.desde ?? diaLocal(ahora);
  const hasta = op.hasta ?? sumarDias(desde, 1);
  if (hasta < desde) throw Errors.validation('La fecha final es anterior a la inicial.');
  if (sumarDias(desde, AGENDA_DIAS_MAX - 1) < hasta) throw Errors.validation(`La agenda muestra hasta ${AGENDA_DIAS_MAX} días.`);
  const epi = epiDeAlcance(alcance);
  const occ = await ocurrencias(db, desde, hasta, epi ? Prisma.sql`AND p.epi_id = ${epi}::uuid` : Prisma.empty);
  const ejecuciones = await db.rutaEjecucion.findMany({
    where: {
      programacionId: { not: null },
      fechaLocal: { gte: new Date(`${desde}T00:00:00.000Z`), lte: new Date(`${hasta}T00:00:00.000Z`) },
      ...(epi ? { epiId: epi } : {}),
    },
    include: { patrullas: { include: { guardia: true } } },
  });
  const progIds = [...new Set([...occ.map((o) => o.programacion_id), ...ejecuciones.map((e) => e.programacionId!)])];
  const [progs, epis] = await Promise.all([
    db.rutaProgramacion.findMany({ where: { id: { in: progIds } } }),
    db.epi.findMany({ select: { id: true, codigo: true } }),
  ]);
  const progPor = new Map(progs.map((p) => [p.id, p]));
  const epiPor = new Map(epis.map((e) => [e.id, e.codigo]));
  const items: HorarioAgenda[] = [];
  const vistos = new Set<string>();
  for (const e of ejecuciones) {
    const clave = `${e.ventanaId}|${fecha(e.fechaLocal)}`;
    vistos.add(clave);
    const activas = e.patrullas.filter((p) => p.estado === 'asignada' || p.estado === 'en_curso');
    items.push({
      clave,
      ejecucionId: e.id,
      programacionId: e.programacionId!,
      ventanaId: e.ventanaId!,
      nombre: e.nombre,
      epiCodigo: e.epiId ? (epiPor.get(e.epiId) ?? null) : null,
      modalidad: e.modalidad,
      rutaPlantillaId: e.rutaPlantillaId,
      puntoFijoId: e.puntoFijoId,
      fechaLocal: fecha(e.fechaLocal)!,
      inicio: e.inicio,
      fin: e.fin!,
      apertura: e.apertura ?? new Date(e.inicio.getTime() - APERTURA_ANTICIPADA_MIN * 60_000),
      cupo: e.capacidad,
      estado: e.estado,
      motivoCierre: e.motivoCierre,
      asignados: activas.length,
      atendieron: new Set(e.patrullas.filter((p) => p.iniciadaEn).map((p) => p.guardiaId)).size,
      guardias: activas.map((p) => ({ patrullaId: p.id, guardiaId: p.guardiaId, guardiaNombre: nombreCompleto(p.guardia), estado: p.estado, puntoFijoId: p.puntoFijoId })),
      asignacionModo: (e.asignacionModo ?? 'manual') as ModoAsignacion,
      automatica: estadoAutomatica(e),
    });
  }
  for (const o of occ) {
    const clave = `${o.ventana_id}|${o.fecha_local}`;
    const p = progPor.get(o.programacion_id);
    // Un horario que terminó antes de existir la programación no es un "no abierto".
    if (vistos.has(clave) || !p || o.fin <= p.createdAt) continue;
    items.push({
      clave,
      ejecucionId: null,
      programacionId: p.id,
      ventanaId: o.ventana_id,
      nombre: p.nombre,
      epiCodigo: epiPor.get(p.epiId) ?? null,
      modalidad: p.modalidad,
      rutaPlantillaId: p.rutaPlantillaId,
      puntoFijoId: p.puntoFijoId,
      fechaLocal: o.fecha_local,
      inicio: o.inicio,
      fin: o.fin,
      apertura: o.apertura,
      cupo: o.cupo,
      estado: o.apertura > ahora ? 'programada' : o.fin <= ahora ? 'no_abierta' : 'por_abrir',
      motivoCierre: null,
      asignados: 0,
      atendieron: 0,
      guardias: [],
      asignacionModo: p.modo as ModoAsignacion,
      automatica: null,
    });
  }
  return items.sort((a, b) => a.inicio.getTime() - b.inicio.getTime() || a.nombre.localeCompare(b.nombre));
}

export interface AvisoPendiente {
  ejecucionId: string;
  programacionId: string;
  nombre: string;
  epiCodigo: string | null;
  modalidad: string;
  puntoFijoId: string | null;
  inicio: Date;
  fin: Date;
  cupo: number;
  asignados: number;
  faltan: number;
  /** false = se abrió para prepararlo (empieza en menos de 15 min). */
  empezado: boolean;
  /** F6: horario automático (el sistema sigue buscando), su radio actual y cuándo vuelve a intentar. */
  automatica: boolean;
  radioM: number | null;
  proximoIntento: Date | null;
}

/**
 * Avisos "Ruta programada X: falta asignar": horarios abiertos con cupo sin
 * cubrir. Se leen de la BD (no dependen del socket): la campana los consulta.
 */
export async function avisosPendientes(alcance: Alcance, ahora = new Date()): Promise<AvisoPendiente[]> {
  const epi = epiDeAlcance(alcance);
  const filas = await db.rutaEjecucion.findMany({
    where: { programacionId: { not: null }, estado: { in: ['pendiente', 'incompleta'] }, fin: { gt: ahora }, ...(epi ? { epiId: epi } : {}) },
    include: { _count: { select: { patrullas: { where: { estado: { in: ['asignada', 'en_curso'] } } } } } },
    orderBy: { inicio: 'asc' },
  });
  const epis = new Map((await db.epi.findMany({ select: { id: true, codigo: true } })).map((e) => [e.id, e.codigo]));
  return filas
    .map((e) => ({
      ejecucionId: e.id,
      programacionId: e.programacionId!,
      nombre: e.nombre,
      epiCodigo: e.epiId ? (epis.get(e.epiId) ?? null) : null,
      modalidad: e.modalidad,
      puntoFijoId: e.puntoFijoId,
      inicio: e.inicio,
      fin: e.fin!,
      cupo: e.capacidad,
      asignados: e._count.patrullas,
      faltan: Math.max(0, e.capacidad - e._count.patrullas),
      empezado: e.inicio <= ahora,
      automatica: e.asignacionModo === 'automatica',
      radioM: e.asignacionModo === 'automatica' ? (e.autoRadioM ?? AUTO_RADIO_INICIAL_M) : null,
      proximoIntento: e.asignacionModo === 'automatica' ? e.autoProximoIntento : null,
    }))
    .filter((a) => a.faltan > 0);
}

/**
 * F6: por qué la asignación automática eligió o descartó a cada guardia en
 * un horario (sus últimos intentos registrados). Segmentado por EPI.
 */
export async function intentosAutomaticos(ejecucionId: string, alcance: Alcance) {
  const e = await db.rutaEjecucion.findUnique({ where: { id: ejecucionId }, select: { id: true, epiId: true, asignacionModo: true } });
  const epi = epiDeAlcance(alcance);
  if (!e || (epi && e.epiId !== epi)) throw Errors.notFound('El horario no existe.');
  const filas = await db.asignacionAutomaticaIntento.findMany({ where: { ejecucionId }, orderBy: { id: 'desc' }, take: 20 });
  return {
    ejecucionId,
    automatica: e.asignacionModo === 'automatica',
    intentos: filas.map((f) => ({ ...f, id: f.id.toString() })),
  };
}

/**
 * F6: el operador terminó de elegir a mano (o cerró el selector): la
 * automática deja de esperarle y sigue al momento con lo que falte. Un horario
 * que estuviera en manual (dato anterior) vuelve a automático, desde 3 km si
 * no tenía radio. No cambia la programación ni los demás horarios.
 */
export async function reanudarAutomatica(ejecucionId: string, actor: ActorProgramacion, j: Jurisdiccion | null) {
  if (!actor.permissions.programacion_rutas?.editar && !actor.permissions.patrullaje?.editar) {
    throw Errors.forbidden('Tu rol no puede reanudar la asignación automática.');
  }
  const e = await db.$transaction(async (tx) => {
    const [fila] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM ruta_ejecucion WHERE id = ${ejecucionId}::uuid FOR UPDATE`;
    if (!fila) throw Errors.notFound('El horario no existe.');
    const e = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id: ejecucionId }, include: { programacion: { select: { modo: true } } } });
    exigirMismaEpi(j, e.epiId, 'El horario');
    if (!e.programacionId) throw Errors.validation('Solo los horarios programados son automáticos.');
    if (e.programacion?.modo !== 'automatica' && e.asignacionModo !== 'automatica') throw Errors.validation('Este horario es manual.');
    if (!['pendiente', 'incompleta', 'activa'].includes(e.estado) || (e.fin && e.fin <= new Date())) throw Errors.conflict('Ese horario ya terminó o fue cancelado.');
    const ahora = new Date();
    const { reservaHasta: _r, ...ultimo } = (e.autoUltimo as Record<string, unknown> | null) ?? {};
    const r = await tx.rutaEjecucion.update({
      where: { id: ejecucionId },
      data: {
        asignacionModo: 'automatica',
        autoRadioM: e.autoRadioM ?? AUTO_RADIO_INICIAL_M,
        autoProximoIntento: ahora,
        // Si venía de manual, la espera para ampliar el radio cuenta desde ahora.
        autoUltimo: (e.asignacionModo === 'automatica' ? ultimo : { ...ultimo, radioDesde: ahora }) as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: { actorUserId: actor.id, accion: 'reanudar_automatica', recurso: 'programacion_rutas', recursoId: ejecucionId, detalle: { antes: e.asignacionModo } },
    });
    return r;
  });
  publicarSeguro([{ tipo: EVENTS.programacionActualizada, epiId: e.epiId, payload: { ejecucionId, programacionId: e.programacionId, estado: e.estado, nombre: e.nombre, soloAgenda: true } }]);
  return { ejecucionId, asignacionModo: 'automatica' as const };
}

// --- Planificador: estado e interruptor ----------------------------------------

export async function estadoPlanificador(global: boolean) {
  const e = await db.planificadorEstado.findUnique({ where: { id: 1 } });
  const registros = global ? await db.planificadorRegistro.findMany({ orderBy: { inicio: 'desc' }, take: 20 }) : [];
  const abiertos = await db.rutaEjecucion.count({ where: { programacionId: { not: null }, estado: { in: ['pendiente', 'activa', 'incompleta'] } } });
  return {
    habilitado: e?.habilitado ?? true,
    ultimaPasada: e?.ultimaPasada ?? null,
    ultimaPasadaOk: e?.ultimaPasadaOk ?? null,
    // Detalle de errores y registro: solo supervisión global (citan programaciones de todas las EPIs).
    ultimoError: global ? (e?.ultimoError ?? null) : null,
    cambiadoEn: e?.cambiadoEn ?? null,
    motivo: e?.motivo ?? null,
    intervaloSeg: PLANIFICADOR_INTERVALO_MS / 1000,
    aperturaAnticipadaMin: APERTURA_ANTICIPADA_MIN,
    reintentoAutomaticoMin: AUTO_REINTENTO_MIN,
    horariosAbiertos: abiertos,
    registros: registros.map((r) => ({ ...r, id: r.id.toString() })),
  };
}

export async function cambiarPlanificador(habilitado: boolean, motivo: string | null, actor: ActorProgramacion) {
  if (actor.role !== 'super_admin') throw Errors.forbidden('Solo el Super Administrador puede pausar o reanudar el planificador.');
  await db.$transaction(async (tx) => {
    await tx.planificadorEstado.update({ where: { id: 1 }, data: { habilitado, motivo, cambiadoPorId: actor.id, cambiadoEn: new Date() } });
    await tx.auditLog.create({
      data: { actorUserId: actor.id, accion: habilitado ? 'reanudar_planificador' : 'pausar_planificador', recurso: 'programacion_rutas', recursoId: 'planificador', detalle: { motivo } },
    });
  });
  publicarSeguro([{ tipo: EVENTS.programacionActualizada, epiId: null, payload: { planificador: { habilitado } } }]);
  return estadoPlanificador(true);
}
