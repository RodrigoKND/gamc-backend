import type { Prisma, hecho_estado, nivel_riesgo } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';

export interface HechoRow {
  id: string;
  tipoHecho: string;
  tipoLabel: string;
  descripcion: string;
  nivelRiesgo: string;
  lat: number;
  lng: number;
  direccion: string | null;
  ocurridoEn: Date;
  reportadoEn: Date;
  estado: string;
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
  guardiaNombre: string;
  guardiaId: string;
  tieneEvidencia: boolean;
  evidencias: { id: string; url: string; tipo: string }[];
}

export interface HechoFiltros {
  tipo?: string;
  estado?: string;
  epiId?: string;
  desde?: string;
  hasta?: string;
  q?: string;
}

const HECHO_INCLUDE = {
  tipoHecho: true,
  epi: { select: { codigo: true, nombre: true } },
  guardia: true,
  evidencias: true,
} as const;

function toRow(row: Prisma.HechoGetPayload<{ include: typeof HECHO_INCLUDE }>, includeGuardiaNombre = true): HechoRow {
  return {
    id: row.id,
    tipoHecho: row.tipoHecho.codigo,
    tipoLabel: row.tipoHecho.label,
    descripcion: row.descripcion,
    nivelRiesgo: row.nivelRiesgo,
    lat: row.lat,
    lng: row.lng,
    direccion: row.direccion,
    ocurridoEn: row.ocurridoEn,
    reportadoEn: row.reportadoEn,
    estado: row.estado,
    epiId: row.epiId,
    epiCodigo: row.epi?.codigo ?? null,
    epiNombre: row.epi?.nombre ?? null,
    guardiaNombre: includeGuardiaNombre ? nombreCompleto(row.guardia) : '',
    guardiaId: row.guardiaId,
    tieneEvidencia: row.evidencias.length > 0,
    evidencias: row.evidencias.map((e) => ({ id: e.id, url: e.url, tipo: e.tipo })),
  };
}

export async function listHechos(filtros: HechoFiltros = {}): Promise<HechoRow[]> {
  const where: Prisma.HechoWhereInput = {};
  if (filtros.tipo) where.tipoHecho = { codigo: filtros.tipo };
  if (filtros.estado) where.estado = filtros.estado as hecho_estado;
  if (filtros.epiId) where.epiId = filtros.epiId;
  if (filtros.desde || filtros.hasta) {
    where.ocurridoEn = {};
    if (filtros.desde) where.ocurridoEn.gte = new Date(filtros.desde);
    if (filtros.hasta) where.ocurridoEn.lte = new Date(filtros.hasta);
  }
  if (filtros.q) where.descripcion = { contains: filtros.q, mode: 'insensitive' };
  const rows = await db.hecho.findMany({
    where,
    orderBy: { ocurridoEn: 'desc' },
    include: HECHO_INCLUDE,
  });
  return rows.map((row) => toRow(row));
}

export async function listTiposHecho() {
  return db.tipoHecho.findMany({ orderBy: { orden: 'asc' }, select: { id: true, codigo: true, label: true } });
}

export interface HechoEvidenciaInput {
  url: string;
  tipo?: 'foto' | 'video';
}

export interface CrearHechoMovilInput {
  guardiaId: string;
  tipoHechoId?: string | null;
  tipoCodigo?: string | null;
  descripcion: string;
  nivelRiesgo: nivel_riesgo;
  lat: number;
  lng: number;
  ocurridoEn?: Date;
  direccion?: string | null;
  turnoId?: string | null;
  evidencias?: HechoEvidenciaInput[];
}

export interface HechoMovilRow extends HechoRow {
  turnoId: string | null;
}

// Alta de hecho desde el MÓVIL (BD_UNIFICADA §5.3). El `guardiaId` sale del
// JWT; `epi_id` se toma de la jurisdicción del guardia (el punto-en-polígono
// real queda pendiente de PostGIS, ver nota del doc).
export async function crearHechoMovil(input: CrearHechoMovilInput): Promise<HechoMovilRow> {
  const guardia = await db.guardia.findUnique({
    where: { id: input.guardiaId },
    select: { epiId: true },
  });
  if (!guardia) throw Errors.notFound('Guardia no encontrado.');

  let tipoHechoId = input.tipoHechoId ?? null;
  if (!tipoHechoId) {
    if (!input.tipoCodigo) throw Errors.validation('Indique tipoHechoId o tipoCodigo.');
    const tipo = await db.tipoHecho.findUnique({
      where: { codigo: input.tipoCodigo },
      select: { id: true },
    });
    if (!tipo) throw Errors.validation(`Tipo de hecho desconocido: ${input.tipoCodigo}.`);
    tipoHechoId = tipo.id;
  }

  let turnoId = input.turnoId ?? null;
  if (turnoId) {
    const turno = await db.turno.findUnique({ where: { id: turnoId }, select: { guardiaId: true } });
    if (!turno || turno.guardiaId !== input.guardiaId) throw Errors.notFound('Turno no encontrado.');
  } else {
    const abierto = await db.turno.findFirst({
      where: { guardiaId: input.guardiaId, estado: 'en_servicio' },
      select: { id: true },
    });
    turnoId = abierto?.id ?? null;
  }

  const created = await db.hecho.create({
    data: {
      guardiaId: input.guardiaId,
      turnoId,
      tipoHechoId,
      descripcion: input.descripcion,
      nivelRiesgo: input.nivelRiesgo,
      lat: input.lat,
      lng: input.lng,
      epiId: guardia.epiId,
      direccion: input.direccion ?? null,
      ocurridoEn: input.ocurridoEn ?? new Date(),
      estado: 'reportado',
      ...(input.evidencias && input.evidencias.length > 0
        ? {
            evidencias: {
              create: input.evidencias.map((e) => ({ url: e.url, tipo: e.tipo ?? 'foto' })),
            },
          }
        : {}),
    },
    include: HECHO_INCLUDE,
  });

  await logAudit({
    actorUserId: null,
    actorTipo: 'guardia',
    accion: 'reportar_hecho',
    recurso: 'hechos',
    recursoId: created.id,
  });
  const base = toRow(created);
  publish(EVENTS.hechoActualizado, base);
  return { ...base, turnoId: created.turnoId };
}

export async function listHechosDeGuardia(guardiaId: string): Promise<HechoRow[]> {
  const rows = await db.hecho.findMany({
    where: { guardiaId },
    orderBy: { ocurridoEn: 'desc' },
    take: 200,
    include: HECHO_INCLUDE,
  });
  return rows.map((row) => toRow(row));
}

export async function changeHechoEstado(id: string, estado: hecho_estado, actorId: string): Promise<HechoRow> {
  try {
    await db.hecho.update({
      where: { id },
      data: { estado, estadoCambiadoPorId: actorId, estadoCambiadoEn: new Date() },
    });
  } catch {
    throw Errors.notFound('Hecho no encontrado.');
  }
  const row = await db.hecho.findUnique({
    where: { id },
    include: HECHO_INCLUDE,
  });
  if (!row) throw Errors.notFound('Hecho no encontrado.');
  await logAudit({ actorUserId: actorId, accion: `hecho_${estado}`, recurso: 'hechos', recursoId: id });
  publish(EVENTS.hechoActualizado, toRow(row));
  return toRow(row);
}