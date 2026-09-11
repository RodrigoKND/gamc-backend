import type { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { reverseGeocode } from '@shared/geocoding';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';

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
  precisionM: number | null;
  capturadoEn: Date;
  turnoInicio: Date | null;
}

export async function ubicacionesActuales(): Promise<UbicacionGuardiaRow[]> {
  interface Point {
    guardiaId: string;
    lat: number;
    lng: number;
    esSos: boolean;
    sosEstado: string | null;
    bateriaPct: number | null;
    precisionM: number | null;
    capturadoEn: Date;
  }
  const points = await db.$queryRaw<Point[]>`
    select distinct on (guardia_id)
      guardia_id as "guardiaId", lat, lng, es_sos as "esSos",
      sos_estado as "sosEstado", bateria_pct as "bateriaPct",
      precision_m as "precisionM", capturado_en as "capturadoEn"
    from guardia_telemetria
    order by guardia_id, capturado_en desc
    limit 500`;
  if (points.length === 0) return [];
  const [guardias, turnosAbiertos] = await Promise.all([
    db.guardia.findMany({
      where: { id: { in: points.map((p) => p.guardiaId) } },
      include: { epi: { select: { codigo: true, nombre: true } } },
    }),
    db.turno.findMany({
      where: { guardiaId: { in: points.map((p) => p.guardiaId) }, estado: 'en_servicio' },
      select: { guardiaId: true, horainicio: true },
    }),
  ]);
  const porId = new Map(guardias.map((g) => [g.id, g]));
  const turnoInicioPorGuardia = new Map(turnosAbiertos.map((t) => [t.guardiaId, t.horainicio]));
  const out: UbicacionGuardiaRow[] = [];
  for (const p of points) {
    const g = porId.get(p.guardiaId);
    if (!g) continue;
    // Geocodificación inversa (cacheada/throttled, ver shared/geocoding.ts)
    // — secuencial a propósito para respetar el límite de Nominatim.
    const direccion = await reverseGeocode(p.lat, p.lng);
    out.push({
      guardiaId: g.id,
      guardiaNombre: nombreCompleto(g),
      epiId: g.epiId,
      epiCodigo: g.epi?.codigo ?? null,
      epiNombre: g.epi?.nombre ?? null,
      lat: p.lat,
      lng: p.lng,
      direccion,
      esSos: p.esSos,
      sosEstado: p.sosEstado,
      estadoOperativo: g.estadoOperativo,
      bateriaPct: p.bateriaPct != null ? Number(p.bateriaPct) : null,
      precisionM: p.precisionM != null ? Number(p.precisionM) : null,
      capturadoEn: new Date(p.capturadoEn),
      turnoInicio: turnoInicioPorGuardia.get(p.guardiaId) ?? null,
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
  }));
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