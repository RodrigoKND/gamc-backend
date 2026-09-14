import type { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { peekAddress } from './geocoding.service.js';

export interface UbicacionGuardiaRow {
  guardiaId: string;
  guardiaNombre: string;
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
  lat: number;
  lng: number;
  direccion: string | null;
  esSos: boolean;
  sosEstado: string | null;
  estadoOperativo: string;
  bateriaPct: number | null;
  turnoId: string | null;
  turnoInicio: Date | null;
  capturadoEn: Date;
}

export async function ubicacionesActuales(): Promise<UbicacionGuardiaRow[]> {
  interface Point {
    guardiaId: string;
    lat: number;
    lng: number;
    esSos: boolean;
    sosEstado: string | null;
    bateriaPct: number | null;
    turnoId: string | null;
    capturadoEn: Date;
  }
  const points = await db.$queryRaw<Point[]>`
    select distinct on (guardia_id)
      guardia_id as "guardiaId", lat, lng, es_sos as "esSos",
      sos_estado as "sosEstado", bateria_pct as "bateriaPct",
      turno_id as "turnoId", capturado_en as "capturadoEn"
    from guardia_telemetria
    order by guardia_id, capturado_en desc
    limit 500`;
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
  const out: UbicacionGuardiaRow[] = [];
  for (const p of points) {
    const g = porId.get(p.guardiaId);
    if (!g) continue;
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
      estadoOperativo: g.estadoOperativo,
      bateriaPct: p.bateriaPct,
      turnoId: p.turnoId,
      turnoInicio: p.turnoId ? (turnoPorId.get(p.turnoId) ?? null) : null,
      capturadoEn: new Date(p.capturadoEn),
    });
  }
  return out;
}

export async function patrullasVigentes() {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const rows = await db.patrulla.findMany({
    where: { estado: { in: ['asignada', 'en_curso'] }, fecha: { gte: hoy } },
    orderBy: { createdAt: 'desc' },
    include: {
      guardia: true,
      rutaPlantilla: { select: { nombre: true, trazado: true } },
      epi: { select: { codigo: true, nombre: true } },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    estado: p.estado,
    guardiaId: p.guardiaId,
    guardiaNombre: nombreCompleto(p.guardia),
    asignadoPorId: p.asignadoPorId,
    rutaPlantillaId: p.rutaPlantillaId,
    rutaNombre: p.rutaPlantilla?.nombre ?? null,
    trazado: p.rutaPlantilla?.trazado ?? null,
    poligonoGeojson: p.poligonoGeojson,
    epiId: p.epiId,
    epiCodigo: p.epi?.codigo ?? null,
    epiNombre: p.epi?.nombre ?? null,
    iniciadaEn: p.iniciadaEn,
    fecha: p.fecha,
  }));
}

export async function rutasPlantilla() {
  const rows = await db.rutaPlantilla.findMany({
    where: { activo: true },
    orderBy: { nombre: 'asc' },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    nombre: r.nombre,
    descripcion: r.descripcion,
    epiId: r.epiId,
    epiCodigo: r.epi?.codigo ?? null,
    epiNombre: r.epi?.nombre ?? null,
    trazado: r.trazado,
    activo: r.activo,
  }));
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
  creadoPorId: string;
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
  const ruta = await db.rutaPlantilla.create({
    data: {
      nombre: input.nombre,
      descripcion: input.descripcion ?? null,
      epiId: input.epiId ?? null,
      trazado: input.trazado as Prisma.InputJsonValue,
      activo: input.activo ?? true,
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
  };
}

// RF-G3-09 (rediseño de rutas 2026-09-14): cancela TODAS las filas
// `patrulla` vigentes (estado asignada|en_curso) que comparten un mismo
// `rutaPlantillaId` — "cancelar la ruta" es una acción sobre la ruta
// compartida, no sobre un guardia individual (para sacar a un solo guardia
// de una ruta grupal sin tocar a los demás haría falta un endpoint aparte,
// no pedido todavía). No borra la fila (soft-cancel, `estado='cancelada'`)
// para no perder el historial/auditoría — igual que `cerrarTurno` reusa
// `completadaEn` como "cuándo dejó de estar vigente" para cualquier estado
// terminal, no solo 'completada'.
export async function cancelarRuta(rutaPlantillaId: string, actorUserId: string) {
  const vigentes = await db.patrulla.findMany({
    where: { rutaPlantillaId, estado: { in: ['asignada', 'en_curso'] } },
    select: { id: true, guardiaId: true },
  });
  if (vigentes.length === 0) {
    throw Errors.notFound('No hay guardias con esta ruta vigente para cancelar.');
  }

  await db.patrulla.updateMany({
    where: { id: { in: vigentes.map((p) => p.id) } },
    data: { estado: 'cancelada', completadaEn: new Date() },
  });

  await logAudit({
    actorUserId,
    accion: 'cancelar_ruta',
    recurso: 'patrullaje',
    recursoId: rutaPlantillaId,
    detalle: { patrullasCanceladas: vigentes.map((p) => p.id) },
  });
  publish(EVENTS.patrullaCancelada, {
    rutaPlantillaId,
    guardiaIds: vigentes.map((p) => p.guardiaId),
  });

  return { rutaPlantillaId, cancelados: vigentes.length };
}

// Complemento de cancelarRuta (pedido explícito 2026-09-14): sacar a UN
// guardia (o varios, de a uno) de una ruta compartida sin tocar a los
// demás — cancela solo su propia fila `patrulla`, no las del resto del
// grupo. Mismo criterio soft-cancel que cancelarRuta.
export async function cancelarPatrulla(patrullaId: string, actorUserId: string) {
  const patrulla = await db.patrulla.findUnique({
    where: { id: patrullaId },
    select: { id: true, guardiaId: true, rutaPlantillaId: true, estado: true },
  });
  if (!patrulla || !['asignada', 'en_curso'].includes(patrulla.estado)) {
    throw Errors.notFound('No hay una asignación vigente con ese id para cancelar.');
  }

  await db.patrulla.update({
    where: { id: patrullaId },
    data: { estado: 'cancelada', completadaEn: new Date() },
  });

  await logAudit({
    actorUserId,
    accion: 'cancelar_patrulla',
    recurso: 'patrullaje',
    recursoId: patrullaId,
    detalle: { guardiaId: patrulla.guardiaId, rutaPlantillaId: patrulla.rutaPlantillaId },
  });
  publish(EVENTS.patrullaCancelada, {
    rutaPlantillaId: patrulla.rutaPlantillaId,
    guardiaIds: [patrulla.guardiaId],
  });

  return { patrullaId, guardiaId: patrulla.guardiaId };
}

export async function zonasCriticas() {
  const rows = await db.zonaCriticaActiva.findMany({
    where: { vigente: true },
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

export interface AsignarPatrullaInput {
  guardiaId: string;
  rutaPlantillaId?: string | null;
  epiId?: string | null;
  nombre?: string | null;
  descripcion?: string | null;
  poligonoGeojson?: Prisma.InputJsonValue | null;
  asignadoPorId: string;
  fecha?: Date;
}

export async function asignarPatrulla(input: AsignarPatrullaInput) {
  const guardia = await db.guardia.findUnique({ where: { id: input.guardiaId } });
  if (!guardia) throw Errors.validation('La guardia indicada no existe.');
  const patrulla = await db.patrulla.create({
    data: {
      guardiaId: input.guardiaId,
      rutaPlantillaId: input.rutaPlantillaId ?? null,
      epiId: input.epiId ?? guardia.epiId ?? null,
      nombre: input.nombre ?? null,
      descripcion: input.descripcion ?? null,
      poligonoGeojson: input.poligonoGeojson ?? undefined,
      asignadoPorId: input.asignadoPorId,
      estado: 'asignada',
      fecha: input.fecha ?? new Date(),
      iniciadaEn: new Date(),
      horaInicioPrevista: input.fecha ?? null,
    },
  });
  await logAudit({
    actorUserId: input.asignadoPorId,
    accion: 'asignar_patrulla',
    recurso: 'patrullaje',
    recursoId: patrulla.id,
    detalle: input,
  });
  publish(EVENTS.patrullaAsignada, {
    id: patrulla.id,
    guardiaId: patrulla.guardiaId,
    estado: patrulla.estado,
    nombre: patrulla.nombre,
    iniciadaEn: patrulla.iniciadaEn,
  });
  return patrulla;
}

export async function heatmap(params: { desde?: string; hasta?: string; epiId?: string } = {}) {
  const where: Prisma.HechoWhereInput = {};
  if (params.epiId) where.epiId = params.epiId;
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

export async function recalcularZonasCriticas(actorId: string) {
  // Ventana últimos 7 días: agrupa por epi, cuenta y toma riesgo predominante
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const grupos = await db.hecho.groupBy({
    by: ['epiId'],
    where: { ocurridoEn: { gte: desde } },
    _count: { id: true },
  });
  if (grupos.length === 0) return [];
  // invalidar anteriores
  await db.zonaCriticaActiva.updateMany({ where: { vigente: true }, data: { vigente: false } });
  const out = [];
  for (const g of grupos) {
    const hechos = await db.hecho.findMany({
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
    const zona = await db.zonaCriticaActiva.create({
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
  await logAudit({ actorUserId: actorId, accion: 'recalcular_zonas', recurso: 'mapas', detalle: { zonas: out.length } });
  return out.map((z) => ({
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