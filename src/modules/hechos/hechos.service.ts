import type { Prisma, hecho_estado } from '@prisma/client';
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
}

export interface HechoFiltros {
  tipo?: string;
  estado?: string;
  epiId?: string;
  desde?: string;
  hasta?: string;
  q?: string;
}

function toRow(row: Prisma.HechoGetPayload<{
  include: { tipoHecho: true; epi: { select: { codigo: true; nombre: true } }; guardia: true };
}>, includeGuardiaNombre = true): HechoRow {
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
    include: { tipoHecho: true, epi: { select: { codigo: true, nombre: true } }, guardia: true },
  });
  return rows.map((row) => toRow(row));
}

export async function listTiposHecho() {
  return db.tipoHecho.findMany({ orderBy: { orden: 'asc' }, select: { id: true, codigo: true, label: true } });
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
    include: { tipoHecho: true, epi: { select: { codigo: true, nombre: true } }, guardia: true },
  });
  if (!row) throw Errors.notFound('Hecho no encontrado.');
  await logAudit({ actorUserId: actorId, accion: `hecho_${estado}`, recurso: 'hechos', recursoId: id });
  publish(EVENTS.hechoActualizado, toRow(row));
  return toRow(row);
}