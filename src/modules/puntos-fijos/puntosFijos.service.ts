import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { AppError, Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS, isRealtimeReady, publishTerritorial } from '@infra/realtime';
import { logger } from '@infra/logger';
import { clasificarPunto } from '@modules/epis/index';
import { enAlcance, epiDeAlcance, epiEfectiva, exigirDentroDeEpi, exigirMismaEpi, type Alcance, type Jurisdiccion } from '@modules/mapas/jurisdiccion';
import { publicarSeguro, retirarAsignaciones } from '@modules/ejecuciones/ejecuciones.service';
import {
  ASIGNACION_ACTIVA,
  DISTANCIA_MAX_SUBPUNTO_M,
  bloquearPunto,
  capacidadEfectiva,
  destinoDe,
  distanciaM,
  hojasDe,
  ocupantesDe,
  type FilaPunto,
  type Ocupante,
} from './ocupacion.js';

// Catálogo de puntos fijos (F4). Lo administran el Operador (en su
// EPI) y el Super Admin con el permiso `puntos_fijos`; el Admin solo lo ve.
// Nada de lo ocupado se cambia en silencio: mover o desactivar un
// punto con guardias exige una política explícita (trasladar o retirar) y
// queda en punto_fijo_version con los guardias afectados.

export type Politica = 'trasladar' | 'retirar';

interface ActorPermisos {
  id: string;
  role: string;
  permissions: Record<string, { ver?: boolean; crear?: boolean; editar?: boolean; eliminar?: boolean } | undefined>;
}

function exigirPermiso(actor: ActorPermisos, accion: 'crear' | 'editar' | 'eliminar') {
  if (!actor.permissions.puntos_fijos?.[accion]) {
    const que = { crear: 'crear', editar: 'editar', eliminar: 'desactivar' }[accion];
    throw Errors.forbidden(`Tu rol no puede ${que} puntos fijos.`);
  }
}

/** 409 con la lista de guardias afectados: el operador decide qué hacer con ellos. */
export class PuntoOcupado extends AppError {
  constructor(mensaje: string, ocupantes: OcupanteDto[], opciones: Politica[]) {
    super(409, 'PUNTO_OCUPADO', mensaje, { ocupantes, opciones });
  }
}

export interface OcupanteDto {
  guardiaId: string;
  guardiaNombre: string;
  patrullaId: string;
  puntoFijoId: string;
}

async function conNombres(tx: Tx | typeof db, ocupantes: Ocupante[]): Promise<OcupanteDto[]> {
  if (ocupantes.length === 0) return [];
  const guardias = await tx.guardia.findMany({ where: { id: { in: ocupantes.map((o) => o.guardiaId) } } });
  const nombre = new Map(guardias.map((g) => [g.id, nombreCompleto(g)]));
  return ocupantes.map((o) => ({ guardiaId: o.guardiaId, guardiaNombre: nombre.get(o.guardiaId) ?? o.guardiaId, patrullaId: o.patrullaId, puntoFijoId: o.puntoFijoId }));
}

// --- Lectura ----------------------------------------------------------------

export interface PuntoFijoDto {
  id: string;
  codigo: string;
  padreId: string | null;
  nombre: string;
  descripcion: string | null;
  epiId: string;
  epiCodigo: string;
  epiNombre: string;
  epiMetodo: string;
  lat: number;
  lng: number;
  /** Del punto completo: la suma de sus subpuntos activos, si los tiene. */
  capacidad: number;
  ocupados: number;
  coordenadasAproximadas: boolean;
  origen: string;
  activo: boolean;
  version: number;
  /** Solo dentro del alcance de quien consulta (fuera, solo el conteo). */
  ocupantes: { guardiaId: string; guardiaNombre: string; patrullaId: string }[] | null;
  /** Ejecución abierta del punto (solo dentro del alcance). */
  ejecucionId: string | null;
  subpuntos: PuntoFijoDto[];
}

export interface ListarOpciones {
  incluirInactivos?: boolean;
  epiCodigo?: string;
}

/**
 * Catálogo con ocupación AUTORITATIVA (contada en el servidor), SEGMENTADO
 * por EPI como las rutas (F3, pedido del usuario 16/10): un Operador o Admin
 * solo recibe los puntos de su EPI; el Super Admin, todos. El filtro `epi`
 * del cliente solo reduce, nunca amplía.
 */
export async function listarPuntosFijos(alcance: Alcance, op: ListarOpciones = {}): Promise<PuntoFijoDto[]> {
  const filtroEpi = op.epiCodigo ? await db.epi.findUnique({ where: { codigo: op.epiCodigo }, select: { id: true } }) : null;
  if (op.epiCodigo && !filtroEpi) return [];
  const epi = epiEfectiva(alcance, filtroEpi?.id);
  if (epi === null) return [];
  const filas = await db.puntoFijo.findMany({
    where: { ...(op.incluirInactivos ? {} : { activo: true }), ...(epi ? { epiId: epi } : {}) },
    orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  const ocupantes = await conNombres(db, await ocupantesDe(db, filas.map((f) => f.id), { actuales: true }));
  const abiertas = await db.rutaEjecucion.findMany({
    where: { puntoFijoId: { in: filas.map((f) => f.id) }, estado: { in: ['activa', 'incompleta'] } },
    select: { id: true, puntoFijoId: true },
  });
  const ejecucionPor = new Map(abiertas.map((e) => [e.puntoFijoId!, e.id]));

  const dto = (f: (typeof filas)[number], hijos: (typeof filas)[number][]): PuntoFijoDto => {
    const visible = enAlcance(alcance, f.epiId);
    const hojas = f.padreId ? [f] : hojasDe(f, hijos);
    const aqui = ocupantes.filter((o) => hojas.some((h) => h.id === o.puntoFijoId));
    return {
      id: f.id,
      codigo: f.codigo,
      padreId: f.padreId,
      nombre: f.nombre,
      descripcion: f.descripcion,
      epiId: f.epiId,
      epiCodigo: f.epi.codigo,
      epiNombre: f.epi.nombre,
      epiMetodo: f.epiMetodo,
      lat: f.lat,
      lng: f.lng,
      capacidad: f.padreId ? f.capacidad : capacidadEfectiva(f, hijos),
      ocupados: aqui.length,
      coordenadasAproximadas: f.coordenadasAproximadas,
      origen: f.origen,
      activo: f.activo,
      version: f.version,
      ocupantes: visible ? aqui.map(({ guardiaId, guardiaNombre, patrullaId }) => ({ guardiaId, guardiaNombre, patrullaId })) : null,
      ejecucionId: visible ? (ejecucionPor.get(f.padreId ?? f.id) ?? null) : null,
      subpuntos: f.padreId ? [] : hijos.map((h) => dto(h, [])),
    };
  };
  return filas.filter((f) => !f.padreId).map((r) => dto(r, filas.filter((f) => f.padreId === r.id)));
}

// --- Escritura ----------------------------------------------------------------

function codigoDe(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return `${base || 'punto'}_${randomBytes(3).toString('hex')}`;
}

/** EPI de un punto principal: la de su ubicación; el Super Admin puede fijarla a mano. */
async function epiParaPunto(lat: number, lng: number, j: Jurisdiccion | null, epiCodigo?: string | null): Promise<{ epiId: string; metodo: 'ubicacion' | 'manual' }> {
  if (j) {
    if (epiCodigo && epiCodigo !== j.epiCodigo) throw Errors.forbidden(`Solo puedes crear puntos fijos en tu EPI (${j.epiNombre}).`);
    try {
      exigirDentroDeEpi(j, { type: 'Point', coordinates: [lng, lat] });
    } catch {
      throw Errors.forbidden(`El punto queda fuera de los límites de tu jurisdicción (${j.epiNombre}).`);
    }
    return { epiId: j.epiId, metodo: 'ubicacion' };
  }
  const c = await clasificarPunto([lng, lat]);
  if (epiCodigo) {
    const epi = await db.epi.findUnique({ where: { codigo: epiCodigo }, select: { id: true, activo: true } });
    if (!epi?.activo) throw Errors.validation('La EPI indicada no existe o no está operativa.');
    return { epiId: epi.id, metodo: epi.id === c.epiId ? 'ubicacion' : 'manual' };
  }
  if (!c.epiId) throw Errors.validation('El punto queda fuera de todas las EPIs. Indica la EPI a la que pertenece.');
  return { epiId: c.epiId, metodo: 'ubicacion' };
}

async function registrarVersion(
  tx: Tx,
  p: FilaPunto,
  cambio: 'creado' | 'editado' | 'trasladado' | 'desactivado' | 'reactivado',
  actorId: string,
  extra: { politica?: Politica | null; afectados?: OcupanteDto[]; motivo?: string | null } = {},
) {
  await tx.puntoFijoVersion.create({
    data: {
      puntoFijoId: p.id,
      version: p.version,
      cambio,
      nombre: p.nombre,
      epiId: p.epiId,
      lat: p.lat,
      lng: p.lng,
      capacidad: p.capacidad,
      activo: p.activo,
      politica: extra.politica ?? null,
      afectados: extra.afectados && extra.afectados.length > 0 ? (extra.afectados as unknown as Prisma.InputJsonValue) : undefined,
      motivo: extra.motivo ?? null,
      cambiadoPorId: actorId,
    },
  });
}

/** La raíz guarda la suma de sus subpuntos activos (capacidad del punto completo). */
async function sincronizarCapacidadRaiz(tx: Tx, raizId: string) {
  const hijos = await tx.puntoFijo.findMany({ where: { padreId: raizId, activo: true }, select: { capacidad: true } });
  if (hijos.length === 0) return;
  const total = Math.min(50, hijos.reduce((s, h) => s + h.capacidad, 0));
  await tx.puntoFijo.update({ where: { id: raizId }, data: { capacidad: total } });
}

function avisarCambio(puntoFijoId: string, epiId: string | null, extra: Record<string, unknown> = {}, epiAnterior?: string | null) {
  if (!isRealtimeReady()) return;
  try {
    // Segmentado (F3): solo a la EPI del punto y a supervisión. Si cambió de
    // EPI, también a la anterior, para que el pin desaparezca allí.
    publishTerritorial(EVENTS.puntoFijoActualizado, epiId, { id: puntoFijoId, epiId, ...extra });
    if (epiAnterior && epiAnterior !== epiId) publishTerritorial(EVENTS.puntoFijoActualizado, epiAnterior, { id: puntoFijoId, epiId, ...extra });
  } catch (err) {
    logger.warn({ err }, 'No se pudo publicar el cambio de punto fijo');
  }
}

export interface CrearPuntoInput {
  nombre: string;
  descripcion?: string | null;
  lat: number;
  lng: number;
  capacidad: number;
  padreId?: string | null;
  /** Solo Super Admin y solo puntos principales. */
  epiCodigo?: string | null;
  coordenadasAproximadas?: boolean;
}

export async function crearPuntoFijo(input: CrearPuntoInput, actor: ActorPermisos, j: Jurisdiccion | null) {
  exigirPermiso(actor, 'crear');
  const creado = await db.$transaction(async (tx) => {
    if (input.padreId) {
      // Subpunto: hereda la EPI de su punto y debe ser parte del mismo lugar.
      const pb = await bloquearPunto(tx, input.padreId);
      if (pb.objetivo.padreId) throw Errors.validation('Un subpunto no puede tener subpuntos (solo un nivel).');
      if (!pb.raiz.activo) throw Errors.conflict('El punto está desactivado.');
      exigirMismaEpi(j, pb.raiz.epiId, 'El punto fijo');
      if (input.epiCodigo) throw Errors.validation('Un subpunto usa la EPI de su punto.');
      const d = distanciaM(pb.raiz, input);
      if (d > DISTANCIA_MAX_SUBPUNTO_M) {
        throw Errors.validation(`El subpunto está a ${Math.round(d)} m de «${pb.raiz.nombre}»; debe estar a menos de ${DISTANCIA_MAX_SUBPUNTO_M} m.`);
      }
      // El primer subpunto convierte al punto en "contenedor": si ya tiene
      // guardias asignados directamente, no se reparten en silencio.
      if (pb.hojas.length === 1 && pb.hojas[0]!.id === pb.raiz.id) {
        const ocupantes = await ocupantesDe(tx, [pb.raiz.id]);
        if (ocupantes.length > 0) {
          throw new PuntoOcupado(`«${pb.raiz.nombre}» tiene guardias asignados. Retíralos antes de dividirlo en subpuntos.`, await conNombres(tx, ocupantes), []);
        }
      }
      const p = await tx.puntoFijo.create({
        data: {
          codigo: codigoDe(`${pb.raiz.nombre}_${input.nombre}`),
          padreId: pb.raiz.id,
          nombre: input.nombre,
          descripcion: input.descripcion ?? null,
          epiId: pb.raiz.epiId,
          epiMetodo: 'padre',
          lat: input.lat,
          lng: input.lng,
          capacidad: input.capacidad,
          orden: pb.subpuntos.length + 1,
          coordenadasAproximadas: input.coordenadasAproximadas ?? true,
          origen: 'manual',
          creadoPorId: actor.id,
          actualizadoPorId: actor.id,
        },
      });
      await registrarVersion(tx, p, 'creado', actor.id);
      await sincronizarCapacidadRaiz(tx, pb.raiz.id);
      return p;
    }
    const { epiId, metodo } = await epiParaPunto(input.lat, input.lng, j, input.epiCodigo);
    const p = await tx.puntoFijo.create({
      data: {
        codigo: codigoDe(input.nombre),
        nombre: input.nombre,
        descripcion: input.descripcion ?? null,
        epiId,
        epiMetodo: metodo,
        lat: input.lat,
        lng: input.lng,
        capacidad: input.capacidad,
        orden: 100,
        coordenadasAproximadas: input.coordenadasAproximadas ?? true,
        origen: 'manual',
        creadoPorId: actor.id,
        actualizadoPorId: actor.id,
      },
    });
    await registrarVersion(tx, p, 'creado', actor.id);
    await tx.auditLog.create({ data: { actorUserId: actor.id, accion: 'crear_punto_fijo', recurso: 'puntos_fijos', recursoId: p.id, detalle: { nombre: p.nombre, padreId: p.padreId } } });
    return p;
  });
  avisarCambio(creado.id, creado.epiId);
  return creado;
}

export interface ActualizarPuntoInput {
  nombre?: string;
  descripcion?: string | null;
  lat?: number;
  lng?: number;
  capacidad?: number;
  activo?: boolean;
  coordenadasAproximadas?: boolean;
  /** Solo Super Admin y solo puntos principales. */
  epiCodigo?: string | null;
  /** Qué hacer con los guardias asignados si el cambio los afecta. */
  politicaOcupados?: Politica;
  motivo?: string | null;
}

/**
 * Edita un punto. Reglas para lo ocupado:
 *  · bajar la capacidad por debajo de los guardias asignados: rechazado;
 *  · mover un punto ocupado: exige "trasladar" (sus guardias reciben el
 *    nuevo destino) o "retirar" (salen del punto);
 *  · desactivar un punto ocupado, o cambiarlo de EPI: exige "retirar".
 * Todo con la raíz bloqueada: no compite con una asignación simultánea.
 */
export async function actualizarPuntoFijo(id: string, patch: ActualizarPuntoInput, actor: ActorPermisos, j: Jurisdiccion | null) {
  exigirPermiso(actor, patch.activo === false ? 'eliminar' : 'editar');
  const res = await db.$transaction(
    async (tx) => {
      const pb = await bloquearPunto(tx, id);
      const p = pb.objetivo;
      const esRaiz = !p.padreId;
      exigirMismaEpi(j, pb.raiz.epiId, 'Este punto fijo');

      const mueve = (patch.lat !== undefined && patch.lat !== p.lat) || (patch.lng !== undefined && patch.lng !== p.lng);
      const desactiva = patch.activo === false && p.activo;
      const reactiva = patch.activo === true && !p.activo;
      const nuevaPos = { lat: patch.lat ?? p.lat, lng: patch.lng ?? p.lng };
      const tieneSubpuntos = esRaiz && pb.subpuntos.some((s) => s.activo);

      if (patch.capacidad !== undefined && esRaiz && tieneSubpuntos) {
        throw Errors.validation('La capacidad de un punto con subpuntos es la suma de sus subpuntos: edita cada subpunto.');
      }
      if (patch.epiCodigo !== undefined && !esRaiz) throw Errors.validation('Un subpunto usa la EPI de su punto.');
      if (patch.epiCodigo !== undefined && j) throw Errors.forbidden('Solo el Super Administrador puede cambiar la EPI de un punto fijo.');
      if (reactiva && !esRaiz && !pb.raiz.activo) throw Errors.conflict('Reactiva primero el punto principal.');

      // Guardias afectados: los de este punto (si es hoja) o los de todo el
      // punto (si es la raíz y se desactiva o cambia de EPI).
      const hojasPropias = esRaiz ? (tieneSubpuntos ? [] : [p]) : [p];
      const ocupantesPropios = await ocupantesDe(tx, hojasPropias.map((h) => h.id));
      const ocupantesTodos = esRaiz ? await ocupantesDe(tx, pb.hojas.map((h) => h.id)) : ocupantesPropios;

      // Nueva EPI (solo raíz): por ubicación, salvo que el Super Admin la fije.
      let epiNueva = pb.raiz.epiId;
      let metodoNuevo = pb.raiz.epiMetodo;
      if (esRaiz && (mueve || patch.epiCodigo !== undefined)) {
        // epiCodigo null = volver a la EPI por ubicación; sin indicar, se conserva la fijada a mano.
        const manual = p.epiMetodo === 'manual' ? (await tx.epi.findUniqueOrThrow({ where: { id: p.epiId } })).codigo : null;
        const r = await epiParaPunto(nuevaPos.lat, nuevaPos.lng, j, patch.epiCodigo !== undefined ? patch.epiCodigo : manual);
        epiNueva = r.epiId;
        metodoNuevo = r.metodo;
      }
      if (!esRaiz && mueve) {
        const d = distanciaM(pb.raiz, nuevaPos);
        if (d > DISTANCIA_MAX_SUBPUNTO_M) throw Errors.validation(`El subpunto quedaría a ${Math.round(d)} m de «${pb.raiz.nombre}»; máximo ${DISTANCIA_MAX_SUBPUNTO_M} m.`);
      }
      const cambiaEpi = epiNueva !== pb.raiz.epiId;

      if (patch.capacidad !== undefined && patch.capacidad < ocupantesPropios.length) {
        throw new PuntoOcupado(
          `«${p.nombre}» tiene ${ocupantesPropios.length} guardia(s) asignado(s): la capacidad no puede ser menor. Retira guardias antes de reducirla.`,
          await conNombres(tx, ocupantesPropios),
          [],
        );
      }
      if (reactiva && !esRaiz && pb.hojas.length === 1 && pb.hojas[0]!.id === pb.raiz.id && (await ocupantesDe(tx, [pb.raiz.id])).length > 0) {
        throw new PuntoOcupado(`«${pb.raiz.nombre}» tiene guardias asignados directamente. Retíralos antes de reactivar el subpunto.`, await conNombres(tx, await ocupantesDe(tx, [pb.raiz.id])), []);
      }

      // Política exigida según el cambio.
      let afectados: Ocupante[] = [];
      let politica: Politica | null = null;
      if ((desactiva || cambiaEpi) && ocupantesTodos.length > 0) {
        if (patch.politicaOcupados !== 'retirar') {
          throw new PuntoOcupado(
            desactiva
              ? `«${p.nombre}» tiene guardias asignados. Para desactivarlo hay que retirarlos del punto.`
              : `El punto pasaría a otra EPI y tiene guardias asignados. Para moverlo hay que retirarlos.`,
            await conNombres(tx, ocupantesTodos),
            ['retirar'],
          );
        }
        afectados = ocupantesTodos;
        politica = 'retirar';
      } else if (mueve && ocupantesPropios.length > 0) {
        if (patch.politicaOcupados !== 'trasladar' && patch.politicaOcupados !== 'retirar') {
          throw new PuntoOcupado(
            `«${p.nombre}» tiene guardias asignados. Elige si se trasladan a la nueva ubicación o se retiran del punto.`,
            await conNombres(tx, ocupantesPropios),
            ['trasladar', 'retirar'],
          );
        }
        afectados = ocupantesPropios;
        politica = patch.politicaOcupados;
      }
      const afectadosDto = await conNombres(tx, afectados);

      // Aplicar.
      const cambio = desactiva ? 'desactivado' : reactiva ? 'reactivado' : mueve ? 'trasladado' : 'editado';
      const actualizado = await tx.puntoFijo.update({
        where: { id: p.id },
        data: {
          ...(patch.nombre !== undefined ? { nombre: patch.nombre } : {}),
          ...(patch.descripcion !== undefined ? { descripcion: patch.descripcion } : {}),
          ...(patch.capacidad !== undefined ? { capacidad: patch.capacidad } : {}),
          ...(patch.coordenadasAproximadas !== undefined ? { coordenadasAproximadas: patch.coordenadasAproximadas } : {}),
          ...(patch.activo !== undefined ? { activo: patch.activo } : {}),
          lat: nuevaPos.lat,
          lng: nuevaPos.lng,
          ...(esRaiz ? { epiId: epiNueva, epiMetodo: metodoNuevo } : {}),
          version: { increment: 1 },
          actualizadoPorId: actor.id,
          updatedAt: new Date(),
        },
      });
      if (esRaiz && (cambiaEpi || desactiva)) {
        await tx.puntoFijo.updateMany({
          where: { padreId: p.id },
          data: { ...(cambiaEpi ? { epiId: epiNueva } : {}), ...(desactiva ? { activo: false } : {}), updatedAt: new Date() },
        });
      }
      if (!esRaiz && (patch.capacidad !== undefined || desactiva || reactiva)) await sincronizarCapacidadRaiz(tx, pb.raiz.id);

      let cerradas: string[] = [];
      let retiradas: Awaited<ReturnType<typeof retirarAsignaciones>>['retiradas'] = [];
      if (politica === 'retirar') {
        ({ retiradas, cerradas } = await retirarAsignaciones(tx, afectados.map((a) => a.patrullaId), desactiva ? 'punto_desactivado' : 'punto_trasladado'));
      } else if (politica === 'trasladar') {
        // Los guardias reciben el nuevo destino y vuelven a "incorporándose".
        await tx.patrulla.updateMany({
          where: { id: { in: afectados.map((a) => a.patrullaId) }, estado: { in: [...ASIGNACION_ACTIVA] } },
          data: {
            poligonoGeojson: { type: 'Point', coordinates: [nuevaPos.lng, nuevaPos.lat] },
            estadoRuta: 'incorporandose',
            estadoRutaEn: new Date(),
            incorporadaEn: null,
            distanciaRutaM: null,
          },
        });
      }
      // Copia del destino en la ejecución abierta: refleja la versión vigente.
      if (esRaiz && (mueve || patch.nombre !== undefined) && politica !== 'retirar') {
        await tx.rutaEjecucion.updateMany({
          where: { puntoFijoId: p.id, estado: { in: ['activa', 'incompleta'] } },
          data: { destino: destinoDe(actualizado) as Prisma.InputJsonValue, ...(patch.nombre !== undefined ? { nombre: patch.nombre } : {}), updatedAt: new Date() },
        });
      }

      await registrarVersion(tx, actualizado, cambio, actor.id, { politica, afectados: afectadosDto, motivo: patch.motivo });
      await tx.auditLog.create({
        data: {
          actorUserId: actor.id,
          accion: `punto_fijo_${cambio}`,
          recurso: 'puntos_fijos',
          recursoId: p.id,
          detalle: { cambios: patch as unknown as Prisma.InputJsonValue, version: actualizado.version, politica, afectados: afectadosDto.map((a) => a.guardiaId), ejecucionesCerradas: cerradas } as Prisma.InputJsonValue,
        },
      });
      return { actualizado, retiradas, cerradas, politica, afectados: afectadosDto, epiAnterior: pb.raiz.epiId };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
  if (res.retiradas.length > 0) {
    publicarSeguro([
      {
        tipo: EVENTS.patrullaCancelada,
        epiId: res.epiAnterior,
        payload: { guardiaIds: res.retiradas.map((r) => r.guardiaId), ejecucionIds: [...new Set(res.retiradas.map((r) => r.ejecucionId))], motivo: 'punto_fijo' },
      },
    ]);
  }
  avisarCambio(res.actualizado.id, res.actualizado.epiId, { politica: res.politica }, res.epiAnterior);
  return { punto: res.actualizado, politica: res.politica, afectados: res.afectados, ejecucionesCerradas: res.cerradas };
}

/** Historial de versiones de un punto (dentro del alcance). */
export async function historialPuntoFijo(id: string, alcance: Alcance) {
  const p = await db.puntoFijo.findUnique({ where: { id }, select: { epiId: true } });
  if (!p) throw Errors.notFound('El punto fijo no existe.');
  const epi = epiDeAlcance(alcance);
  if (epi && epi !== p.epiId) throw Errors.forbidden('Este punto fijo no pertenece a tu jurisdicción.');
  return db.puntoFijoVersion.findMany({ where: { puntoFijoId: id }, orderBy: { version: 'desc' } });
}
