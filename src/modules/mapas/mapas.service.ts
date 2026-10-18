import { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { esModalidad, type TipoRuta } from '@modules/ejecuciones/config';
import { estadoDespacho, type EstadoDespacho } from '@modules/guardias/sosDespacho';
import { peekAddress, reverseGeocode } from './geocoding.service.js';
import { lineasDe, poligonosDeEpi, trazadoDentro } from '@modules/epis/index';
import { enAlcance, epiDePunto, epiDeAlcance, epiEfectiva, exigirDentroDeEpi, exigirMismaEpi, type Alcance, type Jurisdiccion } from './jurisdiccion.js';

/** Edad máxima (min) de la última posición para considerar "reciente" la EPI actual. */
const EPI_ACTUAL_RECIENTE_MIN = 10;

export interface UbicacionGuardiaRow {
  guardiaId: string;
  guardiaNombre: string;
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
  lat: number;
  lng: number;
  direccion: string | null;
  /** Último ping fue un SOS (dato crudo). Para saber si HAY una alerta abierta usar `sosAbierto`. */
  esSos: boolean;
  sosEstado: string | null;
  /** Hay al menos una alerta SOS sin atender (definición única, F2). */
  sosAbierto: boolean;
  /** Ids de las alertas SOS pendientes (para atender exactamente esas). */
  sosAlertaIds: string[];
  /** A quién se dirigió el SOS abierto (EPI responsable, quién atiende, si ya escaló). */
  sosDespacho: EstadoDespacho | null;
  estadoOperativo: string;
  bateriaPct: number | null;
  turnoId: string | null;
  precisionM: number | null;
  capturadoEn: Date;
  turnoInicio: Date | null;
  /** F3: EPI en la que está ahora (por su última posición válida). */
  epiActual: { codigo: string | null; nombre: string | null; estado: string; desde: Date; frescura: 'reciente' | 'antigua' } | null;
  /**
   * F3: ruta activa del guardia (disponibilidad global). Fuera del
   * alcance de quien consulta solo se sabe que está OCUPADO y en qué EPI:
   * sin nombre ni id de la ruta ajena.
   */
  asignacion: { propia: boolean; epiCodigo: string | null; ejecucionId: string | null; rutaNombre: string | null } | null;
}

/** Alertas SOS sin atender, por guardia. Misma definición en mapa, banner, campana y KPI. */
export async function sosPendientesPorGuardia(): Promise<Map<string, { ids: string[]; desde: Date }>> {
  const rows = await db.$queryRaw<{ guardiaId: string; ids: string[]; desde: Date }[]>`
    SELECT guardia_id AS "guardiaId", array_agg(id::text ORDER BY capturado_en) AS ids, min(capturado_en) AS desde
    FROM guardia_telemetria
    WHERE es_sos AND (sos_estado IS NULL OR sos_estado = 'pendiente')
    GROUP BY guardia_id`;
  return new Map(rows.map((r) => [r.guardiaId, { ids: r.ids, desde: new Date(r.desde) }]));
}

// Última posición de CADA guardia con un LATERAL que usa ix_tele_guardia
// (antes: DISTINCT ON sobre toda la tabla + LIMIT 500, que podía dejar fuera
// guardias y SOS al crecer la telemetría). El SOS se calcula aparte: un ping
// rutinario posterior ya no lo "oculta".
export async function ubicacionesActuales(alcance: Alcance): Promise<UbicacionGuardiaRow[]> {
  interface Point {
    guardiaId: string;
    lat: number;
    lng: number;
    esSos: boolean;
    sosEstado: string | null;
    bateriaPct: number | null;
    turnoId: string | null;
    precisionM: number | null;
    capturadoEn: Date;
  }
  const [points, sos] = await Promise.all([
    db.$queryRaw<Point[]>`
      SELECT g.id AS "guardiaId", t.lat, t.lng, t.es_sos AS "esSos", t.sos_estado AS "sosEstado",
             t.bateria_pct AS "bateriaPct", t.turno_id AS "turnoId", t.precision_m AS "precisionM",
             t.capturado_en AS "capturadoEn"
      FROM guardia g
      JOIN LATERAL (
        SELECT lat, lng, es_sos, sos_estado, bateria_pct, turno_id, precision_m, capturado_en
        FROM guardia_telemetria WHERE guardia_id = g.id ORDER BY capturado_en DESC, id DESC LIMIT 1
      ) t ON true`,
    sosPendientesPorGuardia(),
  ]);
  if (points.length === 0) return [];
  const guardias = await db.guardia.findMany({
    where: { id: { in: points.map((p) => p.guardiaId) } },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  const porId = new Map(guardias.map((g) => [g.id, g]));
  // Resolver hora de inicio del turno activo para mostrar en el drawer
  const turnoIds = points.map((p) => p.turnoId).filter((v): v is string => Boolean(v));
  const turnos = turnoIds.length
    ? await db.turno.findMany({ where: { id: { in: turnoIds } }, select: { id: true, horainicio: true } })
    : [];
  const turnoPorId = new Map(turnos.map((t) => [t.id, t.horainicio]));
  const ids = points.map((p) => p.guardiaId);
  const [actuales, asignaciones] = await Promise.all([
    db.guardiaUbicacionActual.findMany({ where: { guardiaId: { in: ids } }, include: { epi: { select: { codigo: true, nombre: true } } } }),
    db.patrulla.findMany({
      where: { guardiaId: { in: ids }, ...whereVigente() },
      select: { guardiaId: true, epiId: true, ejecucionId: true, nombre: true, ejecucion: { select: { epiId: true, nombre: true } } },
    }),
  ]);
  const codigoEpi = new Map((await db.epi.findMany({ select: { id: true, codigo: true } })).map((e) => [e.id, e.codigo]));
  const actualPor = new Map(actuales.map((a) => [a.guardiaId, a]));
  const asignacionPor = new Map(asignaciones.map((a) => [a.guardiaId, a]));
  const limite = Date.now() - EPI_ACTUAL_RECIENTE_MIN * 60_000;
  const out: UbicacionGuardiaRow[] = [];
  for (const p of points) {
    const g = porId.get(p.guardiaId);
    if (!g) continue;
    const alertas = sos.get(g.id);
    const actual = actualPor.get(g.id);
    const asig = asignacionPor.get(g.id);
    const asigEpi = asig ? (asig.ejecucion?.epiId ?? asig.epiId) : null;
    const propia = asig ? enAlcance(alcance, asigEpi) : false;
    out.push({
      guardiaId: g.id,
      guardiaNombre: nombreCompleto(g),
      epiId: g.epiId,
      epiCodigo: g.epi?.codigo ?? null,
      epiNombre: g.epi?.nombre ?? null,
      lat: p.lat,
      lng: p.lng,
      direccion: peekAddress(p.lat, p.lng) ?? null,
      esSos: p.esSos,
      sosEstado: p.sosEstado,
      sosAbierto: Boolean(alertas),
      sosAlertaIds: alertas?.ids ?? [],
      sosDespacho: alertas ? await estadoDespacho({ guardiaId: g.id, alertaIds: alertas.ids, desde: alertas.desde, lat: p.lat, lng: p.lng }) : null,
      estadoOperativo: g.estadoOperativo,
      bateriaPct: p.bateriaPct,
      precisionM: p.precisionM != null ? Number(p.precisionM) : null,
      turnoId: p.turnoId,
      turnoInicio: p.turnoId ? (turnoPorId.get(p.turnoId) ?? null) : null,
      capturadoEn: new Date(p.capturadoEn),
      epiActual: actual
        ? {
            codigo: actual.epi?.codigo ?? null,
            nombre: actual.epi?.nombre ?? null,
            estado: actual.epiEstado,
            desde: actual.epiDesde,
            frescura: actual.capturadoEn.getTime() >= limite ? 'reciente' : 'antigua',
          }
        : null,
      asignacion: asig
        ? {
            propia,
            epiCodigo: asigEpi ? (codigoEpi.get(asigEpi) ?? null) : null,
            ejecucionId: propia ? asig.ejecucionId : null,
            rutaNombre: propia ? (asig.ejecucion?.nombre ?? asig.nombre ?? null) : null,
          }
        : null,
    });
  }
  return out;
}

/** Fecha local de Bolivia (America/La_Paz) como Date a medianoche UTC, para columnas `date`. */
export function fechaLocalLaPaz(ahora = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * Condición de vigencia (misma regla que v_patrulla_vigente): asignación
 * activa cuya ejecución está abierta y dentro de su ventana [inicio, fin); las
 * filas viejas sin ejecución, solo si son del día LOCAL de Bolivia.
 */
export function whereVigente(ahora = new Date()): Prisma.PatrullaWhereInput {
  return {
    estado: { in: ['asignada', 'en_curso'] },
    OR: [
      { ejecucion: { estado: { in: ['activa', 'incompleta'] }, inicio: { lte: ahora }, OR: [{ fin: null }, { fin: { gt: ahora } }] } },
      { ejecucionId: null, fecha: fechaLocalLaPaz(ahora) },
    ],
  };
}

/** Rutas en curso dentro del alcance (F3): un Operador ve las de su EPI; la ocupación ajena va en ubicaciones. */
export async function patrullasVigentes(alcance: Alcance) {
  const epi = epiDeAlcance(alcance);
  const rows = await db.patrulla.findMany({
    where: {
      AND: [
        whereVigente(),
        ...(epi ? [{ OR: [{ ejecucion: { epiId: epi } }, { ejecucionId: null, epiId: epi }] }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: {
      guardia: true,
      rutaPlantilla: { select: { nombre: true, trazado: true } },
      epi: { select: { codigo: true, nombre: true } },
      ejecucion: true,
      puntoFijo: { select: { id: true, nombre: true, padreId: true } },
    },
  });
  const epis = new Map((await db.epi.findMany({ select: { id: true, codigo: true } })).map((e) => [e.id, e.codigo]));
  return rows.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    estado: p.estado,
    guardiaId: p.guardiaId,
    guardiaNombre: nombreCompleto(p.guardia),
    asignadoPorId: p.asignadoPorId,
    rutaPlantillaId: p.rutaPlantillaId,
    ejecucionId: p.ejecucionId,
    rutaNombre: p.ejecucion?.nombre ?? p.rutaPlantilla?.nombre ?? null,
    // Trazado copiado en la ejecución (snapshot); el de la plantilla solo para filas viejas.
    trazado: p.ejecucion?.trazado ?? p.rutaPlantilla?.trazado ?? null,
    poligonoGeojson: p.poligonoGeojson,
    epiId: p.epiId,
    epiCodigo: p.epi?.codigo ?? null,
    epiNombre: p.epi?.nombre ?? null,
    modalidad: p.modalidad ?? p.ejecucion?.modalidad ?? null,
    estadoRuta: p.estadoRuta,
    distanciaRutaM: p.distanciaRutaM,
    incorporadaEn: p.incorporadaEn,
    // F7: hora límite para incorporarse (vencida sin llegar → advertencia/alerta).
    incorporacionLimite: p.incorporacionLimite,
    estadoRutaEn: p.estadoRutaEn,
    // F4: hoja del punto fijo donde está este guardia (subpunto o el punto).
    puntoFijo: p.puntoFijo ? { id: p.puntoFijo.id, nombre: p.puntoFijo.nombre, esSubpunto: Boolean(p.puntoFijo.padreId) } : null,
    ejecucion: p.ejecucion
      ? {
          id: p.ejecucion.id,
          nombre: p.ejecucion.nombre,
          tipo: p.ejecucion.tipo,
          modalidad: p.ejecucion.modalidad,
          capacidad: p.ejecucion.capacidad,
          unidad: p.ejecucion.unidad,
          inicio: p.ejecucion.inicio,
          fin: p.ejecucion.fin,
          epiCodigo: p.ejecucion.epiId ? (epis.get(p.ejecucion.epiId) ?? null) : null,
          puntoFijoId: p.ejecucion.puntoFijoId,
          destino: p.ejecucion.destino,
          // F6: horario programado (y su modo) para avisar antes de retirar o cancelar.
          programacionId: p.ejecucion.programacionId,
          asignacionModo: p.ejecucion.asignacionModo,
        }
      : null,
    iniciadaEn: p.iniciadaEn,
    fecha: p.fecha,
  }));
}

/** Biblioteca de rutas reutilizables: establecidas (oficiales) y guardadas. */
export async function rutasPlantilla(alcance: Alcance) {
  // Predeterminadas (establecidas) primero, luego las guardadas ('e' < 'g').
  // Alcance (F3): un Operador/Admin solo recibe las rutas de su EPI.
  const epi = epiDeAlcance(alcance);
  const rows = await db.rutaPlantilla.findMany({
    where: { activo: true, ...(epi ? { epiId: epi } : {}) },
    orderBy: [{ tipo: 'asc' }, { nombre: 'asc' }],
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    descripcion: r.descripcion ?? undefined,
    epiId: r.epiId,
    epiCodigo: r.epi?.codigo ?? null,
    epiNombre: r.epi?.nombre ?? null,
    trazado: r.trazado,
    activa: r.activo,
    modalidad: r.modalidad,
    tipo: r.tipo ?? (r.activo ? 'guardada' : 'dinamica'),
    duracionMin: r.duracionMin,
    capacidad: r.capacidad,
    creadaEn: r.createdAt,
  }));
}

type ActorPermisos = { id: string; permissions: Record<string, { crear?: boolean; editar?: boolean; eliminar?: boolean } | undefined> };

/**
 * Permiso sobre una ruta de la biblioteca según su tipo: una predeterminada
 * (establecida) se gestiona con `rutas_establecidas` (los 3 roles web, por
 * decisión del usuario); una guardada, con `patrullaje`.
 */
function exigirPermisoRuta(actor: ActorPermisos, tipo: string | null | undefined, accion: 'crear' | 'editar' | 'eliminar') {
  const establecida = tipo === 'establecida';
  const recurso = establecida ? 'rutas_establecidas' : 'patrullaje';
  // Archivar una guardada es un borrado lógico: basta con poder editarla.
  const accionReal = !establecida && accion === 'eliminar' ? 'editar' : accion;
  if (!actor.permissions[recurso]?.[accionReal]) {
    const que = { crear: 'crear', editar: 'editar', eliminar: 'archivar' }[accion];
    throw Errors.forbidden(`Tu rol no puede ${que} rutas ${establecida ? 'predeterminadas' : 'guardadas'}.`);
  }
}

function validarModalidad(modalidad: string | null | undefined) {
  if (modalidad && !esModalidad(modalidad)) throw Errors.validation('Modalidad desconocida.');
}

/** Borrado lógico: la ruta sale de la biblioteca; las asignaciones en curso no cambian. */
export async function archivarRutaPlantilla(id: string, actor: ActorPermisos, j: Jurisdiccion | null) {
  const r = await db.rutaPlantilla.findUnique({ where: { id } });
  if (!r || !r.activo) throw Errors.notFound('La ruta no existe o ya fue archivada.');
  exigirMismaEpi(j, r.epiId, 'Esta ruta');
  exigirPermisoRuta(actor, r.tipo, 'eliminar');
  await db.rutaPlantilla.update({ where: { id }, data: { activo: false, updatedAt: new Date() } });
  await logAudit({ actorUserId: actor.id, accion: 'archivar_ruta', recurso: 'patrullaje', recursoId: id, detalle: { nombre: r.nombre, tipo: r.tipo } });
  return { id, archivada: true };
}

export interface ActualizarRutaInput {
  nombre?: string;
  descripcion?: string | null;
  tipo?: 'establecida' | 'guardada';
  modalidad?: string | null;
}

/**
 * Edita los parámetros de una ruta de la biblioteca (establecida/guardada).
 * No cambia asignaciones en curso: el trazado ya quedó copiado en su
 * ejecución; aplica a las próximas asignaciones. Desde F5 la ruta no tiene
 * duración ni capacidad propias (se limpian las que tuviera): el horario se
 * programa y el cupo es el de la modalidad.
 */
export async function actualizarRutaPlantilla(
  id: string,
  patch: ActualizarRutaInput,
  actor: ActorPermisos,
  j: Jurisdiccion | null,
) {
  const r = await db.rutaPlantilla.findUnique({ where: { id } });
  if (!r || !r.activo) throw Errors.notFound('La ruta no existe.');
  exigirMismaEpi(j, r.epiId, 'Esta ruta');
  const tipoFinal = (patch.tipo ?? r.tipo) as TipoRuta | null;
  // Cambiar el tipo exige permiso sobre el tipo de origen Y el de destino.
  exigirPermisoRuta(actor, r.tipo, 'editar');
  if (tipoFinal !== r.tipo) exigirPermisoRuta(actor, tipoFinal, 'editar');
  if (tipoFinal !== 'establecida' && tipoFinal !== 'guardada') {
    throw Errors.validation('Solo se editan rutas establecidas o guardadas.');
  }
  const modalidad = patch.modalidad !== undefined ? patch.modalidad : r.modalidad;
  validarModalidad(modalidad);
  const actualizada = await db.rutaPlantilla.update({
    where: { id },
    data: {
      ...(patch.nombre !== undefined ? { nombre: patch.nombre } : {}),
      ...(patch.descripcion !== undefined ? { descripcion: patch.descripcion } : {}),
      tipo: tipoFinal,
      activo: true,
      duracionMin: null,
      capacidad: null,
      modalidad,
      updatedAt: new Date(),
    },
  });
  await logAudit({ actorUserId: actor.id, accion: 'editar_ruta', recurso: 'patrullaje', recursoId: id, detalle: patch as Prisma.InputJsonValue });
  return actualizada;
}

export interface CrearRutaPlantillaInput {
  nombre: string;
  descripcion?: string | null;
  epiId?: string | null;
  /**
   * [lng, lat][] pelado — NO un objeto GeoJSON `{type,coordinates}`. La app
   * móvil ya lee `ruta_plantilla.trazado` con ese formato en producción
   * (`appmunicipal/src/api/patrullas.ts:trazadoAZona`), así que se guarda
   * exactamente así para no romper esa lectura ya existente.
   */
  trazado: [number, number][];
  activo?: boolean;
  modalidad?: string | null;
  /** establecida = predeterminada (oficial); guardada = recurrente. Por defecto guardada. */
  tipo?: 'establecida' | 'guardada';
  creadoPorId: string;
  actor: ActorPermisos;
  /** null/undefined = sin restricción (super_admin). */
  jurisdiccion?: Jurisdiccion | null;
}

// RF-G3-09 (rediseño de rutas 2026-09-14, Web): antes no existía forma de
// crear una `ruta_plantilla` desde ningún cliente (GET /mapas/rutas era de
// solo lectura) — el Operador no podía compartir una misma ruta entre
// varios guardias porque no había dónde guardar el trazado. `activo` ya NO
// significa "existe" sino "aparece en el selector de plantillas
// reutilizables" (ver rutasPlantilla() arriba, que sigue filtrando por
// activo=true) — una ruta creada con activo=false igual queda disponible
// para que `patrulla.rutaPlantillaId` la referencie y agrupe guardias.
export async function crearRutaPlantilla(input: CrearRutaPlantillaInput) {
  if (input.trazado.length < 2 || input.trazado.length > 2000) {
    throw Errors.validation('El trazado de la ruta necesita entre 2 y 2000 puntos.');
  }
  const tipo = input.tipo ?? 'guardada';
  exigirPermisoRuta(input.actor, tipo, 'crear');
  validarModalidad(input.modalidad);
  // Jurisdicción: un Operador/Admin solo crea rutas de su EPI y dentro de
  // su polígono — la EPI de la ruta la fija el backend, no el cliente.
  const j = input.jurisdiccion ?? null;
  if (j && input.epiId) exigirMismaEpi(j, input.epiId, 'La EPI indicada');
  exigirDentroDeEpi(j, input.trazado);
  // super_admin sin EPI explícita: la ruta queda en la EPI donde empieza el
  // trazado, para que los Operadores de esa EPI puedan usarla/cancelarla.
  const epiId = j?.epiId ?? input.epiId ?? (await epiDePunto(input.trazado[0]!));
  if (!j) {
    // Super Admin: no hay rutas multiterritoriales; todo el trazado
    // debe quedar dentro de la EPI donde empieza.
    if (!epiId) throw Errors.validation('La ruta empieza fuera de todas las EPIs.');
    const lineas = lineasDe(input.trazado);
    if (!lineas || !trazadoDentro(lineas, await poligonosDeEpi(epiId)).dentro) {
      throw Errors.validation('La ruta cruza varias EPIs. Divídela en una ruta por EPI.');
    }
  }
  const ruta = await db.rutaPlantilla.create({
    data: {
      nombre: input.nombre,
      descripcion: input.descripcion ?? null,
      epiId,
      trazado: input.trazado as Prisma.InputJsonValue,
      activo: input.activo ?? true,
      modalidad: input.modalidad ?? null,
      tipo,
      creadoPorId: input.creadoPorId,
    },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  await logAudit({
    actorUserId: input.creadoPorId,
    accion: 'crear_ruta_plantilla',
    recurso: 'patrullaje',
    recursoId: ruta.id,
    detalle: { nombre: ruta.nombre, puntos: input.trazado.length, activo: ruta.activo },
  });
  return {
    id: ruta.id,
    nombre: ruta.nombre,
    descripcion: ruta.descripcion,
    epiId: ruta.epiId,
    epiCodigo: ruta.epi?.codigo ?? null,
    epiNombre: ruta.epi?.nombre ?? null,
    trazado: ruta.trazado,
    activo: ruta.activo,
    modalidad: ruta.modalidad,
    tipo: ruta.tipo,
    duracionMin: ruta.duracionMin,
    capacidad: ruta.capacidad,
  };
}

export async function zonasCriticas(alcance: Alcance) {
  const epi = epiDeAlcance(alcance);
  const rows = await db.zonaCriticaActiva.findMany({
    where: { vigente: true, ...(epi ? { epiId: epi } : {}) },
    orderBy: { ventanaHasta: 'desc' },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  return rows.map((z) => ({
    id: z.id,
    epiId: z.epiId,
    epiCodigo: z.epi?.codigo ?? null,
    epiNombre: z.epi?.nombre ?? null,
    centroLat: z.centroLat,
    centroLng: z.centroLng,
    radioM: z.radioM != null ? Number(z.radioM) : null,
    poligono: z.poligono,
    direccion: z.direccion,
    cantidadHechos: z.cantidadHechos,
    nivelRiesgo: z.nivelRiesgo,
    ventanaDesde: z.ventanaDesde,
    ventanaHasta: z.ventanaHasta,
  }));
}

export async function heatmap(alcance: Alcance, params: { desde?: string; hasta?: string; epiId?: string } = {}) {
  const where: Prisma.HechoWhereInput = {};
  const epi = epiEfectiva(alcance, params.epiId);
  if (epi === null) return [];
  if (epi) where.epiId = epi;
  if (params.desde || params.hasta) {
    where.ocurridoEn = {};
    if (params.desde) where.ocurridoEn.gte = new Date(params.desde);
    if (params.hasta) where.ocurridoEn.lte = new Date(params.hasta);
  }
  const rows = await db.hecho.findMany({
    where,
    select: { lat: true, lng: true, nivelRiesgo: true, epiId: true },
    take: 2000,
    orderBy: { ocurridoEn: 'desc' },
  });
  return rows;
}

/**
 * Recalcula las zonas críticas (últimos 7 días) dentro del alcance, de forma
 * ATÓMICA (F3): invalidar las vigentes y crear las nuevas ocurre en una
 * sola transacción con bloqueo consultivo, así dos recálculos simultáneos no
 * dejan zonas duplicadas ni un mapa vacío a medias. Si no hay hechos, las
 * zonas vigentes del alcance caducan igual (antes quedaban para siempre).
 * Un Operador recalcula solo su EPI; los hechos sin EPI no forman zonas.
 */
export async function recalcularZonasCriticas(actorId: string, alcance: Alcance) {
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const epiAlcance = epiDeAlcance(alcance);
  const zonas = await db.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recalcular_zonas'))`;
  const grupos = await tx.hecho.groupBy({
    by: ['epiId'],
    where: { ocurridoEn: { gte: desde }, epiId: epiAlcance ?? { not: null } },
    _count: { id: true },
  });
  await tx.zonaCriticaActiva.updateMany({ where: { vigente: true, ...(epiAlcance ? { epiId: epiAlcance } : {}) }, data: { vigente: false } });
  const out = [];
  for (const g of grupos) {
    const hechos = await tx.hecho.findMany({
      where: { epiId: g.epiId, ocurridoEn: { gte: desde } },
      select: { lat: true, lng: true, nivelRiesgo: true },
    });
    if (hechos.length === 0) continue;
    const lat = hechos.reduce((s, h) => s + h.lat, 0) / hechos.length;
    const lng = hechos.reduce((s, h) => s + h.lng, 0) / hechos.length;
    const conteo = hechos.length;
    // nivel predominante: muy_alto > alto > medio > bajo
    const peso: Record<string, number> = { bajo: 1, medio: 2, alto: 3, muy_alto: 4 };
    const nivel = hechos.reduce((a, b) => (peso[b.nivelRiesgo]! > peso[a.nivelRiesgo]! ? b : a), hechos[0]!).nivelRiesgo as any;
    const ventanaHasta = new Date();
    const zona = await tx.zonaCriticaActiva.create({
      data: {
        epiId: g.epiId,
        centroLat: lat,
        centroLng: lng,
        radioM: 400,
        cantidadHechos: conteo,
        nivelRiesgo: nivel,
        ventanaDesde: desde,
        ventanaHasta,
        vigente: true,
      },
      include: { epi: { select: { codigo: true, nombre: true } } },
    });
    out.push(zona);
  }
  return out;
  });
  await logAudit({ actorUserId: actorId, accion: 'recalcular_zonas', recurso: 'mapas', detalle: { zonas: zonas.length, epiId: epiAlcance ?? null } });
  return zonas.map((z) => ({
    id: z.id,
    epiId: z.epiId,
    epiCodigo: z.epi?.codigo ?? null,
    epiNombre: z.epi?.nombre ?? null,
    centroLat: z.centroLat,
    centroLng: z.centroLng,
    radioM: z.radioM != null ? Number(z.radioM) : null,
    poligono: z.poligono,
    direccion: z.direccion,
    cantidadHechos: z.cantidadHechos,
    nivelRiesgo: z.nivelRiesgo,
    ventanaDesde: z.ventanaDesde,
    ventanaHasta: z.ventanaHasta,
  }));
}

// Geocodifica un lote de puntos (breadcrumb de una ruta asignada, TelemetryDrawer
// en la Web) reusando reverseGeocode — que ya throttlea a 1 req/s a Nominatim,
// cachea 30 días y manda el User-Agent con contacto que exige su política de
// uso. Antes la Web llamaba a Nominatim DIRECTO desde el navegador (4
// requests simultáneos, sin throttle, sin User-Agent) — exactamente lo que
// esa política prohíbe, y la causa real de que a veces quedara pegado en
// "Resolviendo calles" (Nominatim empieza a bloquear/demorar el origen). Se
// resuelve SECUENCIAL (no Promise.all) para que el throttle interno de
// reverseGeocode sea efectivo entre puntos de la misma llamada.
export async function geocodificarPuntos(puntos: { lat: number; lng: number }[]): Promise<(string | null)[]> {
  const direcciones: (string | null)[] = [];
  for (const p of puntos) {
    direcciones.push(await reverseGeocode(p.lat, p.lng));
  }
  return direcciones;
}