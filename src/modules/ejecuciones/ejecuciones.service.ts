import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { AppError, Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS, isRealtimeReady, publish, publishTerritorial } from '@infra/realtime';
import { logger } from '@infra/logger';
import { clasificarPunto, lineasDe, poligonosDeEpi, trazadoDentro } from '@modules/epis/index';
import { exigirDentroDeEpi, exigirMismaEpi, type Jurisdiccion } from '@modules/mapas/jurisdiccion';
import {
  bloquearPunto,
  capacidadEfectiva,
  destinoDe,
  nombreDestino,
  ocupantesDe,
  type FilaPunto,
  type PuntoBloqueado,
} from '@modules/puntos-fijos/ocupacion';
import { CAPACIDAD_MAX, type Modalidad, type TipoRuta } from './config.js';
import { fijarPlazosIncorporacion } from './incorporacion.js';
import { AUTO_RESERVA_MANUAL_MIN } from '@modules/programacion/config';

// Motor de asignación (F2). UNA operación por intención del
// operador, en una sola transacción: bloquea guardias y ejecución, retira las
// asignaciones previas CONFIRMADAS y crea las nuevas. Si algo falla, no queda
// nada a medias (antes la web creaba una patrulla por guardia en un bucle).
//
// Asignación PARCIAL (pedido del usuario): se asigna a los guardias aptos y
// se informa quién no pudo asignarse y por qué (`noAsignados`). Solo se
// rechaza entera si nadie es apto, o si hay retiros de otra ruta sin
// confirmar (eso necesita el consentimiento explícito del operador).
//
// Puntos fijos (F4): se asignan por la IDENTIDAD del punto, no con un
// trazado fabricado. Un punto tiene una sola ejecución abierta (sus guardias
// se suman a ella) y la capacidad se cuenta por hoja (subpunto) con la raíz
// del punto bloqueada, así dos operadores no sobreocupan el último cupo.
//
// Horarios programados (F5): el planificador abre cada horario como una
// ejecución "pendiente" 15 min antes; el operador le asigna guardias con
// este mismo motor (`ejecucionId`), sin crear otra en paralelo. Antes del
// inicio los guardias quedan "asignados" y pasan a "en curso" al empezar el
// horario. Su estado sigue la cobertura (pendiente / incompleta / activa) y
// al terminar se cierra con lo que de verdad pasó: cubierta, cubierta a
// medias o sin cubrir. En un punto fijo, el horario que empieza con
// guardias releva a la asignación anterior del punto (una abierta por punto).
//
// Asignación automática (F6): el planificador usa ESTE mismo motor en nombre
// del sistema (`automatica`). Solo toma guardias libres (nunca retira a nadie
// de otra ruta) y vuelve a comprobar, con los guardias bloqueados, los
// requisitos automáticos (GPS, batería, radio): lo que se eligió fuera de la
// transacción no se da por bueno.
//
// Desde F5 una ruta de la biblioteca ya no tiene duración ni capacidad
// propias: la asignación manual dura hasta cancelarla o hasta que sus
// guardias cierran turno (lo que tiene horario se programa), y el cupo es
// el máximo de la modalidad.

const ACTIVAS = ['asignada', 'en_curso'] as const;
const EJECUCION_ABIERTA = ['pendiente', 'activa', 'incompleta'];

export interface Actor {
  id: string;
  role: string;
  permissions: Record<string, { ver?: boolean; crear?: boolean; editar?: boolean; eliminar?: boolean } | undefined>;
}

export interface GuardiaAsignado {
  guardiaId: string;
  /** Punto del guardia dentro de la ruta [lng, lat] (incorporación). */
  punto?: [number, number] | null;
  /** Punto fijo: subpunto elegido para este guardia (si no, el que tenga más cupo). */
  puntoFijoId?: string | null;
}

export interface Confirmacion {
  guardiaId: string;
  /** Asignación actual que el operador ACEPTÓ retirar (la que vio en el aviso). */
  patrullaId: string;
}

export type OrigenRuta =
  | { rutaPlantillaId: string }
  | {
      nueva: {
        nombre: string;
        descripcion?: string | null;
        trazado: [number, number][];
        tipo: TipoRuta;
      };
    };

export interface AsignarInput {
  actor: Actor;
  jurisdiccion: Jurisdiccion | null;
  claveIdempotencia: string;
  /** Ruta de la biblioteca o trazado nuevo. Se ignora si se pasa `ejecucionId`. */
  ruta?: OrigenRuta;
  /** Sumar guardias a una ejecución activa existente. */
  ejecucionId?: string;
  /** Asignar a un punto fijo del catálogo (punto o subpunto). Excluye `ruta`. */
  puntoFijoId?: string;
  modalidad?: Modalidad;
  nombre?: string | null;
  descripcion?: string | null;
  unidad?: string | null;
  guardias: GuardiaAsignado[];
  confirmaciones?: Confirmacion[];
  /** F6: asignación del sistema (planificador), no de una persona. */
  automatica?: OpcionesAutomatica;
}

export interface OpcionesAutomatica {
  /**
   * Requisitos automáticos revisados DENTRO de la transacción, con los
   * guardias ya bloqueados: devuelve los que dejaron de cumplirlos.
   */
  requisitos: (tx: Tx, guardiaIds: string[], ejecucion: Prisma.RutaEjecucionGetPayload<Record<string, never>>) => Promise<NoAsignado[]>;
}

export interface Conflicto {
  guardiaId: string;
  guardiaNombre: string;
  patrullaId: string;
  ejecucionId: string | null;
  /** Solo si es de la misma jurisdicción del usuario (no se filtran rutas ajenas). */
  rutaNombre: string | null;
  mismaJurisdiccion: boolean;
  /** false = el usuario no puede retirarlo (otra EPI): requiere supervisión. */
  confirmable: boolean;
}

export interface AvisoGuardia {
  guardiaId: string;
  tipo: 'gps_antiguo' | 'sin_gps';
  mensaje: string;
}

export type MotivoNoAsignado =
  | 'no_existe'
  | 'cuenta_inactiva'
  | 'sos'
  | 'sin_turno'
  | 'en_ruta_otra_epi'
  | 'ya_en_esta_ruta'
  | 'ruta_llena'
  | 'punto_lleno'
  // F6, solo en la asignación automática:
  | 'ocupado'
  | 'retirado'
  | 'sin_gps'
  | 'gps_antiguo'
  | 'gps_impreciso'
  | 'bateria_baja'
  | 'bateria_desconocida'
  | 'fuera_de_radio';

/** Guardia que NO quedó asignado, con el motivo para mostrárselo al operador. */
export interface NoAsignado {
  guardiaId: string;
  guardiaNombre: string;
  motivo: MotivoNoAsignado;
  mensaje: string;
}

export interface ResultadoAsignacion {
  ejecucion: EjecucionDto;
  patrullaIds: string[];
  retiradas: { patrullaId: string; guardiaId: string; ejecucionId: string | null }[];
  noAsignados: NoAsignado[];
  avisos: AvisoGuardia[];
}

export interface EjecucionDto {
  id: string;
  rutaPlantillaId: string | null;
  epiId: string | null;
  tipo: string;
  nombre: string;
  descripcion: string | null;
  modalidad: string;
  capacidad: number;
  unidad: string | null;
  origen: string;
  estado: string;
  inicio: Date;
  fin: Date | null;
  puntoFijoId: string | null;
  programacionId: string | null;
}

function aDto(e: Prisma.RutaEjecucionGetPayload<Record<string, never>>): EjecucionDto {
  return {
    id: e.id,
    rutaPlantillaId: e.rutaPlantillaId,
    epiId: e.epiId,
    tipo: e.tipo,
    nombre: e.nombre,
    descripcion: e.descripcion,
    modalidad: e.modalidad,
    capacidad: e.capacidad,
    unidad: e.unidad,
    origen: e.origen,
    estado: e.estado,
    inicio: e.inicio,
    fin: e.fin,
    puntoFijoId: e.puntoFijoId,
    programacionId: e.programacionId,
  };
}

const GPS_ANTIGUO_MIN = 30;

export class ReasignacionRequerida extends AppError {
  constructor(conflictos: Conflicto[]) {
    super(
      409,
      'REASIGNACION_REQUERIDA',
      conflictos.some((c) => !c.confirmable)
        ? 'Algunos guardias están asignados en otra jurisdicción y no puedes retirarlos.'
        : 'Algunos guardias ya tienen una ruta. Confirma que quieres retirarlos de su ruta actual.',
      { conflictos },
    );
  }
}

function huella(input: AsignarInput): string {
  const { actor: _a, jurisdiccion: _j, claveIdempotencia: _k, ...resto } = input;
  return createHash('sha256').update(JSON.stringify(resto)).digest('hex');
}

function puede(actor: Actor, recurso: string, accion: 'crear' | 'editar'): boolean {
  return Boolean(actor.permissions[recurso]?.[accion]);
}

type FilaGuardia = { id: string; estado: string; estado_operativo: string; epi_id: string | null; primer_nombre: string; apellido_paterno: string; apellido_materno: string; segundo_nombre: string | null };

/** Lee los guardias; con `bloquear` los toma FOR UPDATE (la previsualización no bloquea). */
async function bloquearGuardias(tx: Tx, ids: string[], bloquear = true) {
  // Orden estable: dos operaciones sobre los mismos guardias nunca se bloquean en cruz.
  const orden = [...ids].sort();
  return tx.$queryRaw<FilaGuardia[]>`SELECT id, estado::text, estado_operativo::text, epi_id, primer_nombre, segundo_nombre, apellido_paterno, apellido_materno
    FROM guardia WHERE id = ANY(${orden}::uuid[]) ORDER BY id ${bloquear ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
}

function nombreDe(g: FilaGuardia): string {
  return nombreCompleto({ primerNombre: g.primer_nombre, segundoNombre: g.segundo_nombre, apellidoPaterno: g.apellido_paterno, apellidoMaterno: g.apellido_materno });
}

type MotivoFijo = Exclude<MotivoNoAsignado, 'ruta_llena' | 'punto_lleno' | 'retirado' | 'sin_gps' | 'gps_antiguo' | 'gps_impreciso' | 'bateria_baja' | 'bateria_desconocida' | 'fuera_de_radio'>;

const MENSAJE_MOTIVO: Record<MotivoFijo, string> = {
  no_existe: 'El guardia no existe.',
  cuenta_inactiva: 'Su cuenta no está activa.',
  sos: 'Tiene un SOS sin atender. Atiende la alerta antes de asignarle una ruta.',
  sin_turno: 'No está en servicio (no tiene un turno abierto).',
  en_ruta_otra_epi: 'Está en una ruta de otra EPI; solo un Super Administrador puede retirarlo.',
  ya_en_esta_ruta: 'Ya está en esta ruta.',
  ocupado: 'Ya tiene otra ruta: la asignación automática no retira a nadie.',
};

/**
 * Elegibilidad manual de cada guardia: cuenta activa, en servicio con turno
 * abierto y sin SOS. Desde F3 los guardias son LIBRES: no importa su EPI;
 * la ruta pertenece a la EPI del usuario. Devuelve los aptos en
 * el orden pedido y los demás con su motivo.
 */
async function clasificarGuardias(tx: Tx, ids: string[], bloquear: boolean) {
  const filas = await bloquearGuardias(tx, ids, bloquear);
  const porId = new Map(filas.map((g) => [g.id, g]));
  const turnos = await tx.turno.findMany({ where: { guardiaId: { in: ids }, estado: 'en_servicio' }, select: { id: true, guardiaId: true } });
  const turnoPor = new Map(turnos.map((t) => [t.guardiaId, t.id]));
  const conSos = new Set(
    (
      await tx.guardiaTelemetria.findMany({
        where: { guardiaId: { in: ids }, esSos: true, OR: [{ sosEstado: null }, { sosEstado: 'pendiente' }] },
        select: { guardiaId: true },
      })
    ).map((r) => r.guardiaId),
  );
  const aptos: FilaGuardia[] = [];
  const noAsignados: NoAsignado[] = [];
  const excluir = (id: string, nombre: string, motivo: MotivoFijo, mensaje = MENSAJE_MOTIVO[motivo]) => {
    if (!noAsignados.some((n) => n.guardiaId === id)) {
      noAsignados.push({ guardiaId: id, guardiaNombre: nombre, motivo, mensaje });
    }
  };
  for (const id of ids) {
    const g = porId.get(id);
    if (!g) {
      excluir(id, id, 'no_existe');
      continue;
    }
    const nombre = nombreDe(g);
    if (g.estado !== 'activo') excluir(id, nombre, 'cuenta_inactiva');
    else if (g.estado_operativo === 'emergencia' || conSos.has(id)) excluir(id, nombre, 'sos');
    else if (g.estado_operativo !== 'en_servicio' || !turnoPor.has(id)) excluir(id, nombre, 'sin_turno');
    else aptos.push(g);
  }
  return { aptos, noAsignados, turnoPor, excluir };
}

export class SinGuardiasAsignables extends AppError {
  constructor(noAsignados: NoAsignado[]) {
    super(400, 'SIN_GUARDIAS_ASIGNABLES', 'Ningún guardia pudo ser asignado.', { noAsignados });
  }
}

/** EPI y trazado de la ruta, validando jurisdicción y que no cruce varias EPIs. */
async function resolverRuta(tx: Tx, input: AsignarInput, j: Jurisdiccion | null) {
  if (!input.ruta) throw Errors.validation('Indica la ruta a asignar.');
  if ('rutaPlantillaId' in input.ruta) {
    const r = await tx.rutaPlantilla.findUnique({ where: { id: input.ruta.rutaPlantillaId } });
    if (!r) throw Errors.validation('La ruta indicada no existe.');
    if (j) {
      exigirMismaEpi(j, r.epiId, 'La ruta');
      exigirDentroDeEpi(j, r.trazado);
    }
    return {
      plantilla: r,
      epiId: r.epiId,
      trazado: r.trazado as [number, number][] | null,
      tipo: (r.tipo ?? (r.activo ? 'guardada' : 'dinamica')) as TipoRuta,
      modalidadRuta: r.modalidad,
      nombre: r.nombre,
      descripcion: r.descripcion,
    };
  }
  const n = input.ruta.nueva;
  const lineas = lineasDe(n.trazado);
  if (!lineas || lineas[0]!.length < 2) throw Errors.validation('El trazado de la ruta necesita al menos 2 puntos válidos.');
  if (n.tipo === 'establecida' && !puede(input.actor, 'rutas_establecidas', 'crear')) {
    throw Errors.forbidden('Tu rol no puede crear rutas establecidas.');
  }
  let epiId: string | null;
  if (j) {
    exigirDentroDeEpi(j, n.trazado);
    epiId = j.epiId;
  } else {
    // Super Admin: la EPI la decide el inicio del trazado, y TODO el trazado
    // debe quedar dentro de ella (no hay rutas multiterritoriales).
    const c = await clasificarPunto(n.trazado[0]!);
    if (!c.epiId) throw Errors.validation('La ruta empieza fuera de todas las EPIs.');
    if (!trazadoDentro(lineas, await poligonosDeEpi(c.epiId)).dentro) {
      throw Errors.validation('La ruta cruza varias EPIs. Divídela en una ruta por EPI.');
    }
    epiId = c.epiId;
  }
  return {
    plantilla: null,
    epiId,
    trazado: n.trazado,
    tipo: n.tipo,
    modalidadRuta: null as string | null,
    nombre: n.nombre,
    descripcion: n.descripcion ?? null,
  };
}

/**
 * Cierra una ejecución que se quedó sin guardias activos (la ruta desaparece
 * del mapa en vivo). Un horario programado que sigue vigente NO se cierra:
 * vuelve a "pendiente" o "incompleta" (falta asignar) hasta su hora de fin.
 */
export async function cerrarSiVacia(tx: Tx, ejecucionId: string | null | undefined, motivo = 'sin_guardias'): Promise<boolean> {
  if (!ejecucionId) return false;
  const e = await tx.rutaEjecucion.findUnique({ where: { id: ejecucionId }, select: { programacionId: true, fin: true } });
  if (e?.programacionId && (!e.fin || e.fin > new Date())) {
    await actualizarCobertura(tx, ejecucionId);
    return false;
  }
  const quedan = await tx.patrulla.count({ where: { ejecucionId, estado: { in: [...ACTIVAS] } } });
  if (quedan > 0) return false;
  const r = await tx.rutaEjecucion.updateMany({
    where: { id: ejecucionId, estado: { in: EJECUCION_ABIERTA } },
    data: { estado: 'finalizada', motivoCierre: motivo, cerradaEn: new Date(), updatedAt: new Date() },
  });
  return r.count > 0;
}

export type MotivoCobertura = 'cubierta' | 'cubierta_parcial' | 'sin_cubrir';

/** Cómo terminó un horario programado: cuántos guardias lo atendieron de verdad (nunca "completado" sin nadie). */
async function motivoCobertura(tx: Tx, e: { id: string; capacidad: number }): Promise<MotivoCobertura> {
  const [r] = await tx.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT guardia_id)::int AS n FROM patrulla WHERE ejecucion_id = ${e.id}::uuid AND iniciada_en IS NOT NULL`;
  const n = r?.n ?? 0;
  return n === 0 ? 'sin_cubrir' : n < e.capacidad ? 'cubierta_parcial' : 'cubierta';
}

/** Asignación de un punto fijo cerrada por el relevo de un horario programado. */
export interface Relevo {
  ejecucionId: string;
  epiId: string | null;
  guardiaIds: string[];
}

/**
 * Relevo (F5): el horario programado de un punto fijo que empieza con
 * guardias reemplaza a la asignación abierta del punto (la del turno
 * anterior o una manual). Sus guardias quedan libres y siguen en su turno.
 * Se llama con la raíz del punto ya bloqueada.
 */
async function relevarPunto(tx: Tx, entrante: { id: string; puntoFijoId: string | null }, ahora: Date): Promise<Relevo[]> {
  if (!entrante.puntoFijoId) return [];
  const salientes = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM ruta_ejecucion
    WHERE punto_fijo_id = ${entrante.puntoFijoId}::uuid AND id <> ${entrante.id}::uuid AND estado IN ('activa','incompleta')
    ORDER BY id FOR UPDATE`;
  const relevos: Relevo[] = [];
  for (const { id } of salientes) {
    const s = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id } });
    const activas = await tx.patrulla.findMany({
      where: { ejecucionId: id, estado: { in: [...ACTIVAS] } },
      select: { id: true, estado: true, ejecucionId: true, guardiaId: true },
    });
    await terminarPatrullas(tx, activas, 'relevo', 'completada');
    await tx.rutaEjecucion.update({
      where: { id },
      data: { estado: 'finalizada', motivoCierre: s.programacionId ? await motivoCobertura(tx, s) : 'relevo', cerradaEn: ahora, updatedAt: ahora },
    });
    relevos.push({ ejecucionId: id, epiId: s.epiId, guardiaIds: activas.map((a) => a.guardiaId) });
  }
  return relevos;
}

/**
 * Estado de un horario programado según su cobertura: "pendiente" antes de
 * empezar o sin guardias, "incompleta" con menos guardias que su cupo y
 * "activa" con el cupo cubierto. Solo toca horarios programados abiertos.
 */
export async function actualizarCobertura(tx: Tx, ejecucionId: string, ahora = new Date()): Promise<{ estado: string; relevos: Relevo[] } | null> {
  const e = await tx.rutaEjecucion.findUnique({ where: { id: ejecucionId } });
  if (!e?.programacionId || !EJECUCION_ABIERTA.includes(e.estado)) return null;
  const n = await tx.patrulla.count({ where: { ejecucionId, estado: { in: [...ACTIVAS] } } });
  const estado = e.inicio > ahora || n === 0 ? 'pendiente' : n < e.capacidad ? 'incompleta' : 'activa';
  // Una sola asignación abierta por punto: el horario que empieza releva a la anterior.
  const relevos = estado !== 'pendiente' && e.estado === 'pendiente' ? await relevarPunto(tx, e, ahora) : [];
  if (estado !== e.estado) await tx.rutaEjecucion.update({ where: { id: ejecucionId }, data: { estado, updatedAt: ahora } });
  return { estado, relevos };
}

/** Bloquea una ejecución abierta (FOR UPDATE) dentro de la jurisdicción del usuario. */
async function bloquearEjecucionAbierta(tx: Tx, id: string, j: Jurisdiccion | null) {
  const [fila] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM ruta_ejecucion WHERE id = ${id}::uuid FOR UPDATE`;
  if (!fila) throw Errors.notFound('La ruta indicada ya no existe.');
  const e = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id } });
  if (!EJECUCION_ABIERTA.includes(e.estado) || (e.fin && e.fin <= new Date())) throw Errors.conflict('Esa ruta ya terminó o fue cancelada.');
  exigirMismaEpi(j, e.epiId, 'La ruta');
  return e;
}

/**
 * Ejecución abierta del punto fijo (una por punto: los guardias se suman a
 * ella) o una nueva. Si hay un horario programado del punto en curso que
 * nadie atiende todavía, los guardias se suman a ese horario. Sin trazado ni límite de tiempo: los guardias salen al
 * cerrar su turno o cuando el operador los retira.
 */
async function ejecucionDePunto(tx: Tx, punto: PuntoBloqueado, actorId: string) {
  const ahora = new Date();
  const abierta = await tx.rutaEjecucion.findFirst({
    where: {
      puntoFijoId: punto.raiz.id,
      OR: [{ estado: { in: ['activa', 'incompleta'] } }, { estado: 'pendiente', programacionId: { not: null }, inicio: { lte: ahora }, fin: { gt: ahora } }],
    },
    // La abierta primero ('activa' < 'incompleta' < 'pendiente'); si no, el horario en curso más reciente.
    orderBy: [{ estado: 'asc' }, { inicio: 'desc' }],
  });
  if (abierta) {
    await tx.$queryRaw`SELECT id FROM ruta_ejecucion WHERE id = ${abierta.id}::uuid FOR UPDATE`;
    return abierta;
  }
  return tx.rutaEjecucion.create({
    data: {
      epiId: punto.raiz.epiId,
      tipo: 'establecida',
      nombre: punto.raiz.nombre,
      descripcion: punto.raiz.descripcion,
      modalidad: 'punto_fijo',
      capacidad: Math.min(50, Math.max(1, capacidadEfectiva(punto.raiz, punto.subpuntos))),
      origen: 'manual',
      estado: 'activa',
      inicio: new Date(),
      fin: null,
      creadoPorId: actorId,
      puntoFijoId: punto.raiz.id,
      destino: destinoDe(punto.raiz) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Reparte a los guardias entre las hojas del punto con el cupo real de cada
 * una. Un guardia va al subpunto que eligió el operador; si no eligió,
 * al que tenga más cupo libre. Devuelve los que no entran.
 */
function repartirEnPunto(
  punto: PuntoBloqueado,
  ocupantes: { puntoFijoId: string }[],
  guardias: GuardiaAsignado[],
  fuera: Set<string>,
  hojaPor: Map<string, FilaPunto>,
): { guardiaId: string; motivo: 'punto_lleno'; mensaje: string }[] {
  const { raiz, objetivo, hojas } = punto;
  const libres = new Map(hojas.map((h) => [h.id, h.capacidad - ocupantes.filter((o) => o.puntoFijoId === h.id).length]));
  // Si pidió un subpunto concreto, todos van ahí salvo que se indique otro.
  const fijo = objetivo.id !== raiz.id ? objetivo.id : null;
  const lleno = (h: FilaPunto | null) => {
    const total = h ? h.capacidad : hojas.reduce((s, x) => s + x.capacidad, 0);
    return `«${h ? nombreDestino(raiz, h) : raiz.nombre}» está completo (${total} de ${total}).`;
  };
  const out: { guardiaId: string; motivo: 'punto_lleno'; mensaje: string }[] = [];
  for (const g of guardias) {
    if (fuera.has(g.guardiaId)) continue;
    const pedida = g.puntoFijoId ?? fijo;
    if (pedida && !libres.has(pedida)) throw Errors.validation('El subpunto elegido no pertenece a este punto fijo o está desactivado.');
    // sort es estable: a igual cupo libre se respeta el orden del catálogo.
    const hoja = pedida ? hojas.find((h) => h.id === pedida)! : [...hojas].sort((a, b) => libres.get(b.id)! - libres.get(a.id)!)[0]!;
    if (libres.get(hoja.id)! <= 0) {
      out.push({ guardiaId: g.guardiaId, motivo: 'punto_lleno', mensaje: lleno(pedida || hojas.length === 1 ? hoja : null) });
      continue;
    }
    libres.set(hoja.id, libres.get(hoja.id)! - 1);
    hojaPor.set(g.guardiaId, hoja);
  }
  return out;
}

/**
 * Retira asignaciones activas por un cambio del catálogo (punto fijo movido
 * o desactivado con la política "retirar"). Cierra las ejecuciones que
 * quedan vacías. Se llama dentro de la transacción del catálogo.
 */
export async function retirarAsignaciones(tx: Tx, patrullaIds: string[], motivo: string) {
  const retiradas = await tx.patrulla.findMany({
    where: { id: { in: patrullaIds }, estado: { in: [...ACTIVAS] } },
    select: { id: true, estado: true, ejecucionId: true, guardiaId: true, epiId: true, ejecucion: { select: { epiId: true } } },
  });
  await terminarPatrullas(tx, retiradas, motivo, 'cancelada');
  const cerradas: string[] = [];
  for (const ejId of new Set(retiradas.map((p) => p.ejecucionId))) {
    if (await cerrarSiVacia(tx, ejId, motivo)) cerradas.push(ejId!);
  }
  return { retiradas, cerradas };
}

/** Retira asignaciones activas (cancelada/completada) y deja los turnos sin referencia a ellas. */
async function terminarPatrullas(
  tx: Tx,
  patrullas: { id: string; estado: string; ejecucionId: string | null }[],
  motivo: string,
  enCursoComo: 'cancelada' | 'completada',
) {
  const ahora = new Date();
  for (const p of patrullas) {
    await tx.patrulla.update({
      where: { id: p.id },
      data: { estado: p.estado === 'en_curso' ? enCursoComo : 'cancelada', completadaEn: ahora, motivoCierre: motivo },
    });
  }
  if (patrullas.length > 0) {
    await tx.turno.updateMany({ where: { patrullaId: { in: patrullas.map((p) => p.id) } }, data: { patrullaId: null } });
  }
}

/** Conflictos (asignaciones activas) de los guardias, con la visibilidad que corresponde al usuario. */
async function conflictosDe(tx: Tx, guardias: FilaGuardia[], j: Jurisdiccion | null) {
  const activas = await tx.patrulla.findMany({
    where: { guardiaId: { in: guardias.map((g) => g.id) }, estado: { in: [...ACTIVAS] } },
    select: { id: true, guardiaId: true, estado: true, ejecucionId: true, epiId: true, nombre: true, ejecucion: { select: { nombre: true, epiId: true } } },
  });
  const nombrePor = new Map(guardias.map((g) => [g.id, nombreDe(g)]));
  const conflictos: Conflicto[] = [];
  for (const p of activas) {
    const epi = p.ejecucion?.epiId ?? p.epiId;
    const misma = !j || epi === j.epiId;
    conflictos.push({
      guardiaId: p.guardiaId,
      guardiaNombre: nombrePor.get(p.guardiaId) ?? p.guardiaId,
      patrullaId: p.id,
      ejecucionId: p.ejecucionId,
      rutaNombre: misma ? (p.ejecucion?.nombre ?? p.nombre ?? null) : null,
      mismaJurisdiccion: misma,
      // un Operador/Admin solo retira de SU jurisdicción; Super Admin, de cualquiera.
      confirmable: misma,
    });
  }
  return { conflictos, activas };
}

async function avisosGps(guardiaIds: string[]): Promise<AvisoGuardia[]> {
  if (guardiaIds.length === 0) return [];
  const rows = await db.$queryRaw<{ guardia_id: string; capturado_en: Date | null }[]>`
    SELECT g.id AS guardia_id, t.capturado_en
    FROM guardia g
    LEFT JOIN LATERAL (
      SELECT capturado_en FROM guardia_telemetria WHERE guardia_id = g.id ORDER BY capturado_en DESC LIMIT 1
    ) t ON true
    WHERE g.id = ANY(${guardiaIds}::uuid[])`;
  const avisos: AvisoGuardia[] = [];
  for (const r of rows) {
    if (!r.capturado_en) {
      avisos.push({ guardiaId: r.guardia_id, tipo: 'sin_gps', mensaje: 'Sin GPS reportado.' });
      continue;
    }
    const min = Math.round((Date.now() - new Date(r.capturado_en).getTime()) / 60_000);
    if (min > GPS_ANTIGUO_MIN) {
      const texto = min >= 120 ? `hace ${Math.round(min / 60)} h` : `hace ${min} min`;
      avisos.push({ guardiaId: r.guardia_id, tipo: 'gps_antiguo', mensaje: `Último GPS ${texto}.` });
    }
  }
  return avisos;
}

export interface PrevisualizarInput {
  jurisdiccion: Jurisdiccion | null;
  guardias: { guardiaId: string }[];
  /** Sumar guardias a una ejecución existente: estar ya en ella no es un conflicto. */
  ejecucionId?: string;
  /** Asignar a un punto fijo: estar ya en ese punto no es un conflicto. */
  puntoFijoId?: string;
}

/**
 * Previsualización (sin escribir ni bloquear): la web la pide al pasar del
 * paso "Guardias" al siguiente, antes de dibujar la ruta. Devuelve quiénes ya
 * tienen ruta (el operador confirma retirarlos), quiénes no podrán asignarse
 * y por qué, y avisos de GPS. La asignación vuelve a validarlo todo.
 */
export async function previsualizarAsignacion(input: PrevisualizarInput) {
  const ids = [...new Set(input.guardias.map((g) => g.guardiaId))];
  return db.$transaction(async (tx) => {
    const { aptos, noAsignados, excluir } = await clasificarGuardias(tx, ids, false);
    const { conflictos } = await conflictosDe(tx, aptos, input.jurisdiccion);
    let ejecucionId = input.ejecucionId;
    if (input.puntoFijoId) {
      const pf = await tx.puntoFijo.findUnique({ where: { id: input.puntoFijoId }, select: { id: true, padreId: true } });
      if (!pf) throw Errors.notFound('El punto fijo no existe.');
      const abierta = await tx.rutaEjecucion.findFirst({ where: { puntoFijoId: pf.padreId ?? pf.id, estado: { in: ['activa', 'incompleta'] } }, select: { id: true } });
      ejecucionId = abierta?.id;
    }
    for (const c of conflictos) {
      if (ejecucionId && c.ejecucionId === ejecucionId) excluir(c.guardiaId, c.guardiaNombre, 'ya_en_esta_ruta', input.puntoFijoId ? 'Ya está en este punto fijo.' : undefined);
      else if (!c.confirmable) excluir(c.guardiaId, c.guardiaNombre, 'en_ruta_otra_epi');
    }
    const fuera = new Set(noAsignados.map((n) => n.guardiaId));
    return {
      conflictos: conflictos.filter((c) => !fuera.has(c.guardiaId)),
      noAsignados,
      avisos: await avisosGps(ids.filter((id) => !fuera.has(id))),
    };
  });
}

export async function asignarEjecucion(input: AsignarInput): Promise<ResultadoAsignacion> {
  const firma = huella(input);
  const previa = await db.operacionIdempotente.findUnique({ where: { clave: input.claveIdempotencia } });
  if (previa) {
    if (previa.huella !== firma || previa.actorId !== input.actor.id) {
      throw new AppError(409, 'CLAVE_REUTILIZADA', 'Esta operación ya se usó con otros datos. Vuelve a abrir el asistente.');
    }
    return previa.resultado as unknown as ResultadoAsignacion;
  }

  const ids = input.guardias.map((g) => g.guardiaId);
  if (ids.length === 0) throw Errors.validation('Selecciona al menos un guardia.');
  if (new Set(ids).size !== ids.length) throw Errors.validation('Un guardia aparece más de una vez en la asignación.');
  const j = input.jurisdiccion;

  let resultado: ResultadoAsignacion;
  let eventos: Evento[] = [];
  try {
    resultado = await db.$transaction(
      async (tx) => {
        const { aptos, noAsignados, turnoPor, excluir } = await clasificarGuardias(tx, ids, true);

        // --- ejecución destino (nueva o existente) y ruta
        let ejecucion: Prisma.RutaEjecucionGetPayload<Record<string, never>>;
        let plantillaCreadaId: string | null = null;
        // Punto fijo: la raíz del punto se bloquea ANTES que la ejecución
        // (mismo orden que el catálogo al mover/desactivar: sin bloqueos cruzados).
        let punto: PuntoBloqueado | null = null;
        let puntoObjetivoId = input.puntoFijoId ?? null;
        // F5: un horario programado se atiende por su id (no se busca "la abierta del punto").
        let destinoProgramado = false;
        if (input.ejecucionId) {
          const previa = await tx.rutaEjecucion.findUnique({ where: { id: input.ejecucionId }, select: { puntoFijoId: true, programacionId: true } });
          puntoObjetivoId ??= previa?.puntoFijoId ?? null;
          destinoProgramado = Boolean(previa?.programacionId);
        }
        if (puntoObjetivoId) {
          punto = await bloquearPunto(tx, puntoObjetivoId);
          if (!punto.raiz.activo || !punto.objetivo.activo) throw Errors.conflict('Este punto fijo está desactivado.');
          exigirMismaEpi(j, punto.raiz.epiId, 'El punto fijo');
          if (destinoProgramado) {
            ejecucion = await bloquearEjecucionAbierta(tx, input.ejecucionId!, j);
            if (ejecucion.puntoFijoId !== punto.raiz.id) throw Errors.validation('El punto elegido no es el de este horario programado.');
          } else {
            ejecucion = await ejecucionDePunto(tx, punto, input.actor.id);
            if (input.ejecucionId && input.ejecucionId !== ejecucion.id) throw Errors.conflict('Esa asignación del punto ya terminó.');
          }
        } else if (input.ejecucionId) {
          ejecucion = await bloquearEjecucionAbierta(tx, input.ejecucionId, j);
        } else {
          const ruta = await resolverRuta(tx, input, j);
          const modalidad = (input.modalidad ?? ruta.modalidadRuta ?? 'coche') as Modalidad;
          const maxModalidad = CAPACIDAD_MAX[modalidad];
          if (!maxModalidad) throw Errors.validation('Modalidad desconocida.');
          const capacidad = maxModalidad;
          let rutaPlantillaId = ruta.plantilla?.id ?? null;
          if (!ruta.plantilla && input.ruta && 'nueva' in input.ruta) {
            const n = input.ruta.nueva;
            const creada = await tx.rutaPlantilla.create({
              data: {
                nombre: n.nombre,
                descripcion: n.descripcion ?? null,
                epiId: ruta.epiId,
                trazado: n.trazado as Prisma.InputJsonValue,
                // Biblioteca: establecidas y guardadas aparecen para reutilizar; las dinámicas no.
                activo: n.tipo !== 'dinamica',
                modalidad,
                tipo: n.tipo,
                creadoPorId: input.actor.id,
              },
            });
            rutaPlantillaId = creada.id;
            plantillaCreadaId = creada.id;
          }
          const inicio = new Date();
          ejecucion = await tx.rutaEjecucion.create({
            data: {
              rutaPlantillaId,
              epiId: ruta.epiId,
              tipo: ruta.tipo,
              nombre: input.nombre?.trim() || ruta.nombre,
              descripcion: input.descripcion ?? ruta.descripcion,
              modalidad,
              capacidad,
              trazado: (ruta.trazado ?? undefined) as Prisma.InputJsonValue | undefined,
              unidad: input.unidad ?? null,
              origen: 'manual',
              estado: 'activa',
              inicio,
              // Sin hora de fin: termina al cancelarla o cuando sus guardias cierran turno.
              fin: null,
              creadoPorId: input.actor.id,
            },
          });
        }

        // --- reasignaciones: exigir confirmación de EXACTAMENTE lo que hay hoy.
        // Los que están en una ruta de otra EPI (no retirables) o ya en esta
        // misma ruta quedan fuera, informados; el resto necesita confirmación.
        // F6: la automática no retira a nadie: quien ya tiene ruta queda fuera.
        const { conflictos, activas } = await conflictosDe(tx, aptos, j);
        for (const c of conflictos) {
          if (c.ejecucionId === ejecucion.id) excluir(c.guardiaId, c.guardiaNombre, 'ya_en_esta_ruta', punto ? 'Ya está en este punto fijo.' : undefined);
          else if (input.automatica) excluir(c.guardiaId, c.guardiaNombre, 'ocupado');
          else if (!c.confirmable) excluir(c.guardiaId, c.guardiaNombre, 'en_ruta_otra_epi');
        }
        if (input.automatica) {
          const pendientes = aptos.map((a) => a.id).filter((id) => !noAsignados.some((n) => n.guardiaId === id));
          for (const n of await input.automatica.requisitos(tx, pendientes, ejecucion)) {
            if (!noAsignados.some((x) => x.guardiaId === n.guardiaId)) noAsignados.push(n);
          }
        }
        let fuera = new Set(noAsignados.map((n) => n.guardiaId));
        const confirmadas = new Set((input.confirmaciones ?? []).map((c) => `${c.guardiaId}:${c.patrullaId}`));
        const retirables = conflictos.filter((c) => !fuera.has(c.guardiaId));
        if (retirables.some((c) => !confirmadas.has(`${c.guardiaId}:${c.patrullaId}`))) throw new ReasignacionRequerida(retirables);

        // --- capacidad acumulada (incluye a quienes ya están en la ejecución):
        // los que no entran quedan fuera, en el orden en que se eligieron.
        // En un punto fijo se reparte por hoja (subpunto) con su cupo real.
        // F5: un horario programado tiene su PROPIO cupo; en un punto fijo se
        // cuentan solo sus guardias (los del turno al que releva no lo llenan).
        const programada = Boolean(ejecucion.programacionId);
        const hojaPor = new Map<string, FilaPunto>();
        if (punto) {
          const ocupantes = await ocupantesDe(tx, punto.hojas.map((h) => h.id));
          const enCuenta = programada ? ocupantes.filter((o) => o.ejecucionId === ejecucion.id) : ocupantes;
          for (const n of repartirEnPunto(punto, enCuenta, input.guardias, fuera, hojaPor)) {
            const g = aptos.find((a) => a.id === n.guardiaId)!;
            noAsignados.push({ ...n, guardiaNombre: nombreDe(g) });
          }
          fuera = new Set(noAsignados.map((n) => n.guardiaId));
        }
        if (!punto || programada) {
          const ocupados = await tx.patrulla.count({ where: { ejecucionId: ejecucion.id, estado: { in: [...ACTIVAS] } } });
          let libres = Math.max(0, ejecucion.capacidad - ocupados);
          for (const id of ids) {
            if (fuera.has(id)) continue;
            if (libres > 0) {
              libres--;
              continue;
            }
            const g = aptos.find((a) => a.id === id)!;
            const mensaje = programada ? `El horario programado admite hasta ${ejecucion.capacidad} guardia(s).` : `La ruta admite hasta ${ejecucion.capacidad} guardia(s).`;
            noAsignados.push({ guardiaId: id, guardiaNombre: nombreDe(g), motivo: punto ? 'punto_lleno' : 'ruta_llena', mensaje });
          }
        }
        fuera = new Set(noAsignados.map((n) => n.guardiaId));
        const asignar = input.guardias.filter((g) => !fuera.has(g.guardiaId));
        if (asignar.length === 0) throw new SinGuardiasAsignables(noAsignados);
        const asignarIds = asignar.map((g) => g.guardiaId);

        // --- retirar previas confirmadas
        const retirar = activas.filter((p) => p.ejecucionId !== ejecucion.id && asignarIds.includes(p.guardiaId));
        await terminarPatrullas(tx, retirar, 'reasignada', 'cancelada');
        const cerradas: string[] = [];
        for (const ejId of new Set(retirar.map((p) => p.ejecucionId))) {
          if (await cerrarSiVacia(tx, ejId)) cerradas.push(ejId!);
        }

        // --- crear asignaciones (en curso si el guardia ya está en turno). En
        // un horario programado que aún no empieza quedan "asignadas": pasan a
        // "en curso" cuando el planificador inicia el horario.
        const trazado = (ejecucion.trazado as [number, number][] | null) ?? null;
        const ahora = new Date();
        const antesDelInicio = programada && ejecucion.inicio > ahora;
        const patrullaIds: string[] = [];
        for (const g of asignar) {
          const turnoId = turnoPor.get(g.guardiaId)!;
          // Punto fijo: su destino es la hoja asignada (coordenadas del catálogo, no las del cliente).
          const hoja = hojaPor.get(g.guardiaId) ?? null;
          const destino: [number, number] | null = hoja ? [hoja.lng, hoja.lat] : (g.punto ?? trazado?.[0] ?? null);
          const p = await tx.patrulla.create({
            data: {
              guardiaId: g.guardiaId,
              rutaPlantillaId: ejecucion.rutaPlantillaId,
              ejecucionId: ejecucion.id,
              epiId: ejecucion.epiId,
              asignadoPorId: input.actor.id,
              estado: antesDelInicio ? 'asignada' : 'en_curso',
              modalidad: ejecucion.modalidad,
              nombre: hoja && punto ? nombreDestino(punto.raiz, hoja) : ejecucion.nombre,
              descripcion: ejecucion.descripcion,
              poligonoGeojson: destino ? { type: 'Point', coordinates: destino } : undefined,
              puntoFijoId: hoja?.id ?? null,
              turnoId,
              iniciadaEn: antesDelInicio ? null : ahora,
              estadoRuta: antesDelInicio ? null : 'incorporandose',
              estadoRutaEn: antesDelInicio ? null : ahora,
            },
          });
          await tx.turno.update({ where: { id: turnoId }, data: { patrullaId: p.id } });
          patrullaIds.push(p.id);
        }
        // F7: hora límite para llegar a la ruta (las "asignadas" la reciben al iniciar el horario).
        if (!antesDelInicio) await fijarPlazosIncorporacion(tx, patrullaIds, ahora);

        // Horario programado: su estado sigue a la cobertura (y releva al turno anterior del punto).
        let relevos: Relevo[] = [];
        if (programada) {
          relevos = (await actualizarCobertura(tx, ejecucion.id, ahora))?.relevos ?? [];
          ejecucion = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id: ejecucion.id } });
        }

        const res: ResultadoAsignacion = {
          ejecucion: aDto(ejecucion),
          patrullaIds,
          retiradas: retirar.map((p) => ({ patrullaId: p.id, guardiaId: p.guardiaId, ejecucionId: p.ejecucionId })),
          noAsignados,
          avisos: [],
        };

        // Auditoría DENTRO de la transacción: si falla, no queda la asignación.
        // La automática la firma el SISTEMA (en nombre de quien programó).
        await tx.auditLog.create({
          data: {
            actorUserId: input.automatica ? null : input.actor.id,
            actorTipo: input.automatica ? 'sistema' : 'user',
            accion: input.automatica ? 'asignar_automatica' : 'asignar_ruta',
            recurso: 'patrullaje',
            recursoId: ejecucion.id,
            detalle: {
              guardias: asignarIds,
              noAsignados: noAsignados.map((n) => ({ guardiaId: n.guardiaId, motivo: n.motivo })),
              retiradas: res.retiradas,
              plantillaCreada: plantillaCreadaId,
              puntoFijo: punto ? { id: punto.raiz.id, version: punto.raiz.version, hojas: Object.fromEntries([...hojaPor].map(([g, h]) => [g, h.id])) } : null,
              ejecucionesCerradas: cerradas,
              programacion: programada ? { id: ejecucion.programacionId, antesDelInicio, estado: ejecucion.estado, relevos } : null,
              ...(input.automatica ? { programadoPor: input.actor.id } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        await tx.operacionIdempotente.create({
          data: {
            clave: input.claveIdempotencia,
            actorId: input.actor.id,
            operacion: input.automatica ? 'asignar_automatica' : 'asignar_ruta',
            huella: firma,
            resultado: res as unknown as Prisma.InputJsonValue,
          },
        });

        eventos = [
          ...retirar.map((r) => ({
            tipo: EVENTS.patrullaCancelada,
            epiId: r.ejecucion?.epiId ?? r.epiId,
            payload: { id: r.id, guardiaId: r.guardiaId, ejecucionId: r.ejecucionId, motivo: 'reasignada' },
          })),
          ...eventosRelevo(relevos),
          { tipo: EVENTS.patrullaAsignada, epiId: ejecucion.epiId, payload: { ejecucionId: ejecucion.id, epiId: ejecucion.epiId, guardiaIds: asignarIds, patrullaIds, puntoFijoId: ejecucion.puntoFijoId } },
          ...(programada ? [eventoProgramacion(ejecucion)] : []),
        ];
        return res;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  } catch (error) {
    // Otra operación ganó la carrera: el índice único (una asignación activa
    // por guardia) o la clave idempotente ya existían.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '');
      if (target.includes('clave') || target.includes('operacion_idempotente')) {
        const ya = await db.operacionIdempotente.findUnique({ where: { clave: input.claveIdempotencia } });
        if (ya && ya.huella === firma) return ya.resultado as unknown as ResultadoAsignacion;
      }
      throw new AppError(409, 'ASIGNACION_CONCURRENTE', 'Otro operador modificó a estos guardias al mismo tiempo. Revisa y vuelve a intentar.');
    }
    throw error;
  }

  publicarSeguro(eventos);
  const fueraFinal = new Set(resultado.noAsignados.map((n) => n.guardiaId));
  return { ...resultado, avisos: await avisosGps(ids.filter((id) => !fueraFinal.has(id))) };
}

/** Publica tras confirmar. Un fallo del socket NO revierte ni oculta la operación. */
/** `epiId` presente (aunque sea null) = evento territorial: solo a esa EPI y a supervisión global (F3). */
export interface Evento {
  tipo: string;
  payload: unknown;
  epiId?: string | null;
}

/** Guardias liberados por un relevo: el mapa los quita de la asignación anterior. */
export function eventosRelevo(relevos: Relevo[]): Evento[] {
  return relevos.map((r) => ({
    tipo: EVENTS.patrullaCancelada,
    epiId: r.epiId,
    payload: { ejecucionId: r.ejecucionId, epiId: r.epiId, guardiaIds: r.guardiaIds, motivo: 'relevo' },
  }));
}

/** Cambió un horario programado (agenda y campana se actualizan). Solo a su EPI y a supervisión. */
export function eventoProgramacion(e: { id: string; epiId: string | null; programacionId: string | null; estado: string; nombre: string }): Evento {
  return {
    tipo: EVENTS.programacionActualizada,
    epiId: e.epiId,
    payload: { ejecucionId: e.id, programacionId: e.programacionId, estado: e.estado, nombre: e.nombre },
  };
}

export function publicarSeguro(eventos: Evento[]) {
  if (!isRealtimeReady()) return;
  for (const e of eventos) {
    try {
      if ('epiId' in e) publishTerritorial(e.tipo, e.epiId, e.payload);
      else publish(e.tipo, e.payload);
    } catch (err) {
      logger.warn({ err, evento: e.tipo }, 'No se pudo publicar un evento en tiempo real (la operación sí quedó guardada)');
    }
  }
}

/**
 * Cancela una ejecución abierta dentro de la transacción del llamador (la
 * fila ya debe estar bloqueada). Devuelve los eventos a publicar al confirmar.
 */
export async function cancelarEnTransaccion(tx: Tx, ejecucionId: string, actorId: string, motivo = 'cancelada_por_usuario') {
  const e = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id: ejecucionId } });
  const activas = await tx.patrulla.findMany({
    where: { ejecucionId, estado: { in: [...ACTIVAS] } },
    select: { id: true, estado: true, ejecucionId: true, guardiaId: true },
  });
  await terminarPatrullas(tx, activas, 'ruta_cancelada', 'cancelada');
  await tx.rutaEjecucion.update({
    where: { id: ejecucionId },
    data: { estado: 'cancelada', motivoCierre: motivo, cerradaEn: new Date(), cerradaPorId: actorId, updatedAt: new Date() },
  });
  await tx.auditLog.create({
    data: { actorUserId: actorId, accion: 'cancelar_ruta', recurso: 'patrullaje', recursoId: ejecucionId, detalle: { patrullas: activas.map((p) => p.id), motivo } },
  });
  const eventos: Evento[] = [
    {
      tipo: EVENTS.patrullaCancelada,
      epiId: e.epiId,
      payload: { ejecucionId, epiId: e.epiId, rutaPlantillaId: e.rutaPlantillaId, guardiaIds: activas.map((p) => p.guardiaId) },
    },
    ...(e.programacionId ? [eventoProgramacion({ ...e, estado: 'cancelada' })] : []),
  ];
  return { cancelados: activas.length, eventos };
}

/** Cancela UNA ejecución: solo sus guardias activos; otras ejecuciones de la misma plantilla no se tocan. */
export async function cancelarEjecucion(ejecucionId: string, actor: Actor, j: Jurisdiccion | null) {
  const res = await db.$transaction(async (tx) => {
    const [fila] = await tx.$queryRaw<{ estado: string; epi_id: string | null }[]>`SELECT estado, epi_id FROM ruta_ejecucion WHERE id = ${ejecucionId}::uuid FOR UPDATE`;
    if (!fila) throw Errors.notFound('La ruta no existe.');
    exigirMismaEpi(j, fila.epi_id, 'Esta ruta');
    if (!EJECUCION_ABIERTA.includes(fila.estado)) throw Errors.notFound('Esta ruta ya no está vigente.');
    return cancelarEnTransaccion(tx, ejecucionId, actor.id);
  });
  publicarSeguro(res.eventos);
  return { ejecucionId, cancelados: res.cancelados };
}

/**
 * F6: qué hacer con el lugar que deja un guardia retirado de un horario
 * AUTOMÁTICO: buscar al reemplazo más cercano (por defecto) o esperar a que el
 * operador lo elija a mano (reserva de 5 min); el horario sigue automático.
 */
export type Reposicion = 'automatica' | 'manual';

/** Saca a UN guardia de su ruta. Si la ruta queda sin nadie, se cierra. */
export async function retirarGuardia(patrullaId: string, actor: Actor, j: Jurisdiccion | null, opciones: { reposicion?: Reposicion } = {}) {
  const res = await db.$transaction(async (tx) => {
    const [fila] = await tx.$queryRaw<{ guardia_id: string }[]>`SELECT guardia_id FROM patrulla WHERE id = ${patrullaId}::uuid`;
    if (!fila) throw Errors.notFound('No hay una asignación vigente con ese id para cancelar.');
    await bloquearGuardias(tx, [fila.guardia_id]);
    const p = await tx.patrulla.findUnique({
      where: { id: patrullaId },
      select: { id: true, estado: true, ejecucionId: true, guardiaId: true, epiId: true, rutaPlantillaId: true, ejecucion: { select: { epiId: true } } },
    });
    if (!p || !(ACTIVAS as readonly string[]).includes(p.estado)) {
      throw Errors.notFound('No hay una asignación vigente con ese id para cancelar.');
    }
    exigirMismaEpi(j, p.ejecucion?.epiId ?? p.epiId, 'Esta asignación');
    await terminarPatrullas(tx, [p], 'retirado_por_usuario', 'cancelada');
    const cerrada = await cerrarSiVacia(tx, p.ejecucionId);
    // F6: horario automático → reemplazo al momento ("Continuar") o se espera a
    // que el operador lo elija a mano ("Manual", hasta 5 min). Sigue automático.
    let reposicion: Reposicion | null = null;
    let horario: Prisma.RutaEjecucionGetPayload<Record<string, never>> | null = null;
    if (p.ejecucionId) {
      const e = await tx.rutaEjecucion.findUnique({ where: { id: p.ejecucionId } });
      if (e?.programacionId) horario = e;
      if (e?.asignacionModo === 'automatica') {
        reposicion = opciones.reposicion ?? 'automatica';
        const ahora = new Date();
        const reservaHasta = new Date(ahora.getTime() + AUTO_RESERVA_MANUAL_MIN * 60_000);
        const ultimo = (e.autoUltimo as Record<string, unknown> | null) ?? {};
        horario = await tx.rutaEjecucion.update({
          where: { id: e.id },
          data:
            reposicion === 'manual'
              ? { autoProximoIntento: reservaHasta, autoUltimo: { ...ultimo, reservaHasta } as Prisma.InputJsonValue }
              : { autoProximoIntento: ahora },
        });
      }
    }
    await tx.auditLog.create({
      data: {
        actorUserId: actor.id,
        accion: 'cancelar_patrulla',
        recurso: 'patrullaje',
        recursoId: patrullaId,
        detalle: { guardiaId: p.guardiaId, ejecucionId: p.ejecucionId, rutaCerrada: cerrada, ...(reposicion ? { reposicion } : {}) },
      },
    });
    return { p, cerrada, reposicion, horario };
  });
  publicarSeguro([
    { tipo: EVENTS.patrullaCancelada, epiId: res.p.ejecucion?.epiId ?? res.p.epiId, payload: { id: patrullaId, guardiaIds: [res.p.guardiaId], ejecucionId: res.p.ejecucionId, rutaPlantillaId: res.p.rutaPlantillaId, rutaCerrada: res.cerrada } },
    // Horario programado: la agenda y la campana muestran al momento el lugar libre.
    ...(res.horario ? [eventoProgramacion(res.horario)] : []),
  ]);
  return { patrullaId, guardiaId: res.p.guardiaId, rutaCerrada: res.cerrada, ejecucionId: res.p.ejecucionId, reposicion: res.reposicion };
}

/**
 * El guardia cerró su turno: sale de su ruta (en TODAS las rutas, decisión del
 * usuario). La ruta sigue con los demás; si queda vacía, se cierra. Se llama
 * dentro de la transacción de cerrarTurno.
 */
export async function salirDeRutaPorFinDeTurno(tx: Tx, guardiaId: string) {
  const activas = await tx.patrulla.findMany({
    where: { guardiaId, estado: { in: [...ACTIVAS] } },
    select: { id: true, estado: true, ejecucionId: true },
  });
  await terminarPatrullas(tx, activas, 'fin_de_turno', 'completada');
  for (const ej of new Set(activas.map((p) => p.ejecucionId))) await cerrarSiVacia(tx, ej);
  return activas;
}

/**
 * Cierra las ejecuciones vencidas (rutas establecidas/guardadas con duración).
 * Lo corre el servidor cada minuto: funciona aunque no haya operadores
 * conectados. Un lock consultivo evita que dos instancias lo hagan a la vez.
 */
export async function cerrarEjecucionesVencidas(ahora = new Date()): Promise<number> {
  const vencidas = await db.rutaEjecucion.findMany({
    where: { estado: { in: EJECUCION_ABIERTA }, fin: { lte: ahora } },
    select: { id: true },
    take: 200,
  });
  let cerradas = 0;
  for (const { id } of vencidas) {
    const r = await db.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${'vencer:' + id})) AS ok`;
      if (!lock?.ok) return null;
      const [fila] = await tx.$queryRaw<{ estado: string }[]>`SELECT estado FROM ruta_ejecucion WHERE id = ${id}::uuid FOR UPDATE`;
      if (!fila || !EJECUCION_ABIERTA.includes(fila.estado)) return null;
      const previa = await tx.rutaEjecucion.findUniqueOrThrow({ where: { id } });
      const activas = await tx.patrulla.findMany({
        where: { ejecucionId: id, estado: { in: [...ACTIVAS] } },
        select: { id: true, estado: true, ejecucionId: true, guardiaId: true },
      });
      // F5: un horario programado termina con su cobertura real (sin cubrir no es "completado").
      await terminarPatrullas(tx, activas, previa.programacionId ? 'fin_de_horario' : 'vencida', 'completada');
      const motivo = previa.programacionId ? await motivoCobertura(tx, previa) : 'vencida';
      const e = await tx.rutaEjecucion.update({
        where: { id },
        data: { estado: 'finalizada', motivoCierre: motivo, cerradaEn: ahora, updatedAt: ahora },
      });
      return { e, activas };
    });
    if (r) {
      cerradas++;
      publicarSeguro([
        { tipo: EVENTS.patrullaCancelada, epiId: r.e.epiId, payload: { ejecucionId: id, epiId: r.e.epiId, guardiaIds: r.activas.map((p) => p.guardiaId), motivo: 'vencida' } },
        ...(r.e.programacionId ? [eventoProgramacion(r.e)] : []),
      ]);
    }
  }
  return cerradas;
}
