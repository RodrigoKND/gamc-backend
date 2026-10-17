import { Prisma, type hecho_estado, type nivel_riesgo } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { EVENTS, publishTerritorial } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { peekAddress, reverseGeocode } from '@modules/mapas/geocoding.service.js';
import { clasificarPunto, epiPorCodigo } from '@modules/epis/index';
import { enAlcance, epiEfectiva, type Alcance } from '@modules/mapas/jurisdiccion';

export interface HechoEvidenciaRow {
  id: string;
  url: string;
  tipo: string;
}

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
  /** F3: cómo se decidió la EPI (ubicacion | manual | legado). */
  epiMetodo: string | null;
  /** F3: asignada | ambigua | fuera_cobertura (las dos últimas: pendiente de revisión). */
  epiEstado: string | null;
  guardiaNombre: string;
  guardiaId: string;
  evidencias: HechoEvidenciaRow[];
}

const HECHO_INCLUDE = {
  tipoHecho: true,
  epi: { select: { codigo: true, nombre: true } },
  guardia: true,
  evidencias: true,
} satisfies Prisma.HechoInclude;

export interface HechoFiltros {
  tipo?: string;
  estado?: string;
  epiId?: string;
  nivelRiesgo?: string;
  desde?: string;
  hasta?: string;
  q?: string;
  /** 'pendiente' = bandeja de supervisión: EPI ambigua o fuera de cobertura. */
  clasificacion?: string;
}

// Un hecho sin `direccion` guardada (el celular no siempre la manda, ver
// crearHechoMovil) cae acá — mismo patrón que ya usa /mapas/ubicaciones:
// `peekAddress` es síncrono (no bloquea un listado de 200 filas contra el
// límite de Nominatim de 1 req/segundo), devuelve la dirección si ya está
// en caché o dispara la resolución en segundo plano para el próximo
// refresh. Pedido explícito 2026-09-14: la Web NUNCA debe mostrar lat/lng
// crudos, siempre lenguaje natural.
function toRow(row: Prisma.HechoGetPayload<{ include: typeof HECHO_INCLUDE }>, includeGuardiaNombre = true): HechoRow {
  return {
    id: row.id,
    tipoHecho: row.tipoHecho.codigo,
    tipoLabel: row.tipoHecho.label,
    descripcion: row.descripcion,
    nivelRiesgo: row.nivelRiesgo,
    lat: row.lat,
    lng: row.lng,
    direccion: row.direccion ?? peekAddress(row.lat, row.lng) ?? null,
    ocurridoEn: row.ocurridoEn,
    reportadoEn: row.reportadoEn,
    estado: row.estado,
    epiId: row.epiId,
    evidencias: row.evidencias.map((e) => ({ id: e.id, url: e.url, tipo: e.tipo })),
    epiCodigo: row.epi?.codigo ?? null,
    epiNombre: row.epi?.nombre ?? null,
    epiMetodo: row.epiMetodo ?? null,
    epiEstado: row.epiEstado ?? null,
    guardiaNombre: includeGuardiaNombre ? nombreCompleto(row.guardia) : '',
    guardiaId: row.guardiaId,
  };
}

// Alcance (F3): el filtro del cliente solo REDUCE lo que el usuario puede
// ver; nunca lo amplía. Listado, total, exportación y agregados
// usan este mismo where.
function buildHechoWhere(filtros: HechoFiltros, alcance: Alcance): Prisma.HechoWhereInput | null {
  const where: Prisma.HechoWhereInput = {};
  const epi = epiEfectiva(alcance, filtros.epiId);
  if (epi === null) return null;
  if (epi) where.epiId = epi;
  if (filtros.clasificacion === 'pendiente') where.epiEstado = { in: ['ambigua', 'fuera_cobertura'] };
  if (filtros.tipo) where.tipoHecho = { codigo: filtros.tipo };
  if (filtros.estado) where.estado = filtros.estado as hecho_estado;
  if (filtros.nivelRiesgo) where.nivelRiesgo = filtros.nivelRiesgo as nivel_riesgo;
  if (filtros.desde || filtros.hasta) {
    where.ocurridoEn = {};
    if (filtros.desde) where.ocurridoEn.gte = new Date(filtros.desde);
    if (filtros.hasta) where.ocurridoEn.lte = new Date(filtros.hasta);
  }
  if (filtros.q) {
    const q = filtros.q.trim();
    if (q) {
      where.OR = [
        { descripcion: { contains: q, mode: 'insensitive' } },
        { direccion: { contains: q, mode: 'insensitive' } },
        { guardia: { OR: [
          { primerNombre: { contains: q, mode: 'insensitive' } },
          { apellidoPaterno: { contains: q, mode: 'insensitive' } },
          { ci: { contains: q } },
        ]}},
        { tipoHecho: { label: { contains: q, mode: 'insensitive' } } },
      ];
      // El buscador de la web también se usa para "saltar" a un hecho
      // puntual desde una notificación (/hechos?q=<uuid>) — sin esto, un
      // id exacto no matchea ningún texto libre de arriba y la búsqueda
      // por servidor "pierde" ese caso que el filtro client-side viejo sí
      // cubría (comparaba contra el id directamente).
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
        where.OR.push({ id: q });
      }
    }
  }
  return where;
}

// Orden estable: con empates de fecha el id desempata, así las páginas no
// repiten ni pierden filas.
const ORDEN_HECHOS: Prisma.HechoOrderByWithRelationInput[] = [{ ocurridoEn: 'desc' }, { id: 'desc' }];

export async function listHechos(alcance: Alcance, filtros: HechoFiltros & { limit?: number; offset?: number } = {}): Promise<HechoRow[]> {
  const where = buildHechoWhere(filtros, alcance);
  if (!where) return [];
  const take = Math.min(Math.max(filtros.limit ?? 200, 1), 500);
  const skip = Math.max(filtros.offset ?? 0, 0);
  const rows = await db.hecho.findMany({
    where,
    orderBy: ORDEN_HECHOS,
    take,
    skip,
    include: HECHO_INCLUDE,
  });
  return rows.map((row) => toRow(row as any));
}

// Total real (sin `take`) para pintar controles de página — listHechos
// solo/siempre devolvía como máximo `limit` filas (200 por defecto) sin
// forma de saber cuántas había en total detrás de ese corte.
export async function countHechos(alcance: Alcance, filtros: HechoFiltros = {}): Promise<number> {
  const where = buildHechoWhere(filtros, alcance);
  return where ? db.hecho.count({ where }) : 0;
}

export const EXPORTACION_MAX = 20_000;

/**
 * Exportación COMPLETA: todas las filas que cumplen los filtros, dentro
 * del alcance, en orden estable. Antes la web pedía una sola página "grande"
 * (el backend la recortaba a 100/200 filas) y la llamaba exportación. Si se
 * supera el tope, se avisa con `truncado` en vez de cortar en silencio.
 */
export async function exportarHechos(alcance: Alcance, filtros: HechoFiltros = {}): Promise<{ rows: HechoRow[]; total: number; truncado: boolean }> {
  const where = buildHechoWhere(filtros, alcance);
  if (!where) return { rows: [], total: 0, truncado: false };
  return db.$transaction(
    async (tx) => {
      // Misma foto de datos para el total y las filas (REPEATABLE READ).
      const total = await tx.hecho.count({ where });
      const rows: HechoRow[] = [];
      const LOTE = 1_000;
      for (let skip = 0; skip < Math.min(total, EXPORTACION_MAX); skip += LOTE) {
        const lote = await tx.hecho.findMany({ where, orderBy: ORDEN_HECHOS, skip, take: Math.min(LOTE, EXPORTACION_MAX - skip), include: HECHO_INCLUDE });
        rows.push(...lote.map((row) => toRow(row as any)));
      }
      return { rows, total, truncado: total > EXPORTACION_MAX };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
  );
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
// JWT. F3: la EPI del hecho sale de SUS coordenadas, no de la cuenta
// del guardia ni de su última posición. Fuera de todas las EPIs o en un
// solapamiento queda pendiente de revisión (bandeja de supervisión).
export async function crearHechoMovil(input: CrearHechoMovilInput): Promise<HechoMovilRow> {
  const guardia = await db.guardia.findUnique({
    where: { id: input.guardiaId },
    select: { id: true },
  });
  if (!guardia) throw Errors.notFound('Guardia no encontrado.');
  const clasif = await clasificarPunto([input.lng, input.lat]);

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

  // Dirección: no bloquear el alta si Nominatim falla/lentea.
  // Antes await reverseGeocode() podía dejar el POST colgado 5s+ (throttle
  // 1.1s + timeout 5s) y la app móvil lo encolaba offline: la foto ya
  // estaba en Supabase Storage pero el hecho nunca se insertaba. Ahora
  // se guarda sin dirección y se resuelve en segundo plano.
  let direccion: string | null = input.direccion ?? null;
  if (!direccion) {
    try {
      // carrera con timeout corto; si no resuelve rápido, queda null
      const winner = await Promise.race([
        reverseGeocode(input.lat, input.lng),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      direccion = winner;
    } catch {
      direccion = null;
    }
    // si ganó el timeout y Nominatim sigue en vuelo, peekAddress lo
    // cacheará igualmente para el próximo listado; no hace falta reintentar aquí
    if (!direccion) {
      // dispara en background sin bloquear (peekAddress ya lo hace, pero por si acaso)
      void reverseGeocode(input.lat, input.lng).catch(() => {});
    }
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
      epiId: clasif.epiId,
      epiMetodo: 'ubicacion',
      epiEstado: clasif.estado,
      epiTerritorioVersion: clasif.version,
      epiClasificadoEn: new Date(),
      direccion,
      ocurridoEn: input.ocurridoEn ?? new Date(),
      estado: 'reportado',
      ...(input.evidencias && input.evidencias.length > 0
        ? {
            evidencias: {
              // Deduplicar URLs de evidencia (evita fotos duplicadas en la DB
              // cuando la app móvil envía la misma foto múltiples veces)
              create: [...new Set(input.evidencias.map((e) => e.url))].map((url) => ({
                url,
                tipo: input.evidencias!.find((e) => e.url === url)?.tipo ?? 'foto',
              })),
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
  publishTerritorial(EVENTS.hechoActualizado, created.epiId, base);
  return { ...base, turnoId: created.turnoId };
}

export async function listHechosDeGuardia(guardiaId: string): Promise<HechoRow[]> {
  const rows = await db.hecho.findMany({
    where: { guardiaId },
    orderBy: { ocurridoEn: 'desc' },
    take: 200,
    include: HECHO_INCLUDE,
  });
  return rows.map((row) => toRow(row as any));
}

/** Un hecho fuera del alcance responde 404, igual que uno inexistente (no se revela que existe). */
async function hechoEnAlcance(id: string, alcance: Alcance) {
  const h = await db.hecho.findUnique({ where: { id }, select: { id: true, epiId: true } });
  if (!h || !enAlcance(alcance, h.epiId)) throw Errors.notFound('Hecho no encontrado.');
  return h;
}

export async function getHecho(id: string, alcance: Alcance): Promise<HechoRow> {
  await hechoEnAlcance(id, alcance);
  const row = await db.hecho.findUniqueOrThrow({ where: { id }, include: HECHO_INCLUDE });
  return toRow(row as any);
}

export async function changeHechoEstado(id: string, estado: hecho_estado, actorId: string, alcance: Alcance): Promise<HechoRow> {
  await hechoEnAlcance(id, alcance);
  await db.hecho.update({
    where: { id },
    data: { estado, estadoCambiadoPorId: actorId, estadoCambiadoEn: new Date() },
  });
  const row = await db.hecho.findUniqueOrThrow({ where: { id }, include: HECHO_INCLUDE });
  await logAudit({ actorUserId: actorId, accion: `hecho_${estado}`, recurso: 'hechos', recursoId: id });
  publishTerritorial(EVENTS.hechoActualizado, row.epiId, toRow(row as any));
  return toRow(row as any);
}

/**
 * Bandeja de supervisión (F3): el Super Admin decide la EPI de un hecho
 * ambiguo o fuera de cobertura (o corrige uno). Queda como método 'manual' y
 * el valor anterior en la auditoría.
 */
export async function clasificarHechoManual(id: string, epiCodigo: string, actorId: string): Promise<HechoRow> {
  const epi = await epiPorCodigo(epiCodigo);
  if (!epi?.operativa) throw Errors.validation('La EPI indicada no existe o no está operativa.');
  const antes = await db.hecho.findUnique({ where: { id }, select: { epiId: true, epiEstado: true, epiMetodo: true } });
  if (!antes) throw Errors.notFound('Hecho no encontrado.');
  const row = await db.hecho.update({
    where: { id },
    data: { epiId: epi.id, epiMetodo: 'manual', epiEstado: 'asignada', epiTerritorioVersion: epi.territorio?.version ?? null, epiClasificadoEn: new Date() },
    include: HECHO_INCLUDE,
  });
  await logAudit({
    actorUserId: actorId,
    accion: 'clasificar_hecho',
    recurso: 'hechos',
    recursoId: id,
    detalle: { antes, despues: { epiId: epi.id, epiCodigo: epi.codigo } },
  });
  const dto = toRow(row as any);
  publishTerritorial(EVENTS.hechoActualizado, antes.epiId, dto);
  if (antes.epiId !== epi.id) publishTerritorial(EVENTS.hechoActualizado, epi.id, dto);
  return dto;
}