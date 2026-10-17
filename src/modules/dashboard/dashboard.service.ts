import { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { epiDeAlcance, type Alcance } from '@modules/mapas/jurisdiccion';

// KPIs y series para el dashboard. Los históricos usan $queryRaw (agrupación
// por día efectiva); los KPIs en vivo van por conteos simples de Prisma.
//
// Alcance (F3): el Admin de una EPI ve los hechos de SU EPI y los guardias
// que hoy están en ella (EPI actual); el Super Admin, todo. Los SOS
// pendientes se cuentan globalmente: el SOS es visible para todos.

/** Fragmento SQL `AND h.epi_id = …` según el alcance (vacío = global). */
function filtroEpiSql(alcance: Alcance, alias = 'h') {
  const epi = epiDeAlcance(alcance);
  return epi ? Prisma.sql`AND ${Prisma.raw(alias)}.epi_id = ${epi}::uuid` : Prisma.empty;
}

function hoyInicio(): Date {
  // Bolivia UTC-4 sin horario de verano. El inicio de "hoy" en La Paz es 00:00-04:00 → 04:00 UTC.
  // Construir directamente desde el ISO YYYY-MM-DD de La Paz evita el doble-offset
  // del hack previo `new Date(toLocaleString) + 4h` (que en servidores UTC corría 4h).
  const isoLaPaz = new Date().toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' }); // YYYY-MM-DD
  return new Date(`${isoLaPaz}T00:00:00-04:00`);
}

function hoyLaPazISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' }); // YYYY-MM-DD
}

export async function kpis(alcance: Alcance) {
  const inicioHoy = hoyInicio();
  const epi = epiDeAlcance(alcance);
  const [hechosHoy, hechosRevision, guardiasServicio, sosPendientes] = await Promise.all([
    db.hecho.count({ where: { ocurridoEn: { gte: inicioHoy }, ...(epi ? { epiId: epi } : {}) } }),
    db.hecho.count({ where: { estado: 'en_revision', ...(epi ? { epiId: epi } : {}) } }),
    db.turno.findMany({
      where: { estado: 'en_servicio', ...(epi ? { guardia: { ubicacionActual: { epiId: epi } } } : {}) },
      select: { guardiaId: true },
    }),
    db.guardiaTelemetria.findMany({
      // Misma definición de alerta abierta que el mapa y el banner (F2).
      where: { esSos: true, OR: [{ sosEstado: null }, { sosEstado: 'pendiente' }] },
      select: { guardiaId: true },
    }),
  ]);

  return {
    hechosHoy,
    hechosEnRevision: hechosRevision,
    guardiasEnServicio: new Set(guardiasServicio.map((t) => t.guardiaId)).size,
    sosPendientes: new Set(sosPendientes.map((t) => t.guardiaId)).size,
  };
}

interface DiaRow { dia: string; total: bigint }
interface TipoRow { tipo: string; total: bigint }
interface ZonaRow { zona: string | null; epiCodigo: string | null; total: bigint }

// generate_series + LEFT JOIN en vez de un GROUP BY simple: un GROUP BY puro
// nunca produce una fila para un día sin hechos, así que la gráfica del
// dashboard omitía esos días en vez de mostrarlos en 0 (un día realmente
// tranquilo se veía igual que un día sin datos todavía).
export async function hechosPorDia(alcance: Alcance, dias = 7) {
  const n = Math.max(1, Math.min(30, dias));
  // Usar fecha de Bolivia para que el gráfico de 7 días coincida con "Hechos Hoy" y con lo que ve el guardia
  const rows = await db.$queryRaw<DiaRow[]>`
    select to_char(d.dia, 'YYYY-MM-DD') as dia, coalesce(count(h.id), 0)::bigint as total
    from generate_series((now() AT TIME ZONE 'America/La_Paz')::date - (${n}::int - 1), (now() AT TIME ZONE 'America/La_Paz')::date, interval '1 day') as d(dia)
    left join hecho h on (h.ocurrido_en AT TIME ZONE 'America/La_Paz')::date = d.dia ${filtroEpiSql(alcance)}
    group by d.dia
    order by d.dia`;
  return rows.map((r) => ({ dia: r.dia, total: Number(r.total) }));
}

export async function hechosPorTipo(alcance: Alcance) {
  const rows = await db.$queryRaw<TipoRow[]>`
    select th.label as tipo, count(h.id)::bigint as total
    from hecho h
    join tipo_hecho th on th.id = h.tipo_hecho_id
    where true ${filtroEpiSql(alcance)}
    group by th.label
    order by total desc`;
  return rows.map((r) => ({ tipo: r.tipo, total: Number(r.total) }));
}

export async function hechosPorZona(alcance: Alcance) {
  const rows = await db.$queryRaw<ZonaRow[]>`
    select e.nombre as zona, e.codigo as "epiCodigo", count(h.id)::bigint as total
    from hecho h
    left join epi e on e.id = h.epi_id
    where true ${filtroEpiSql(alcance)}
    group by e.nombre, e.codigo
    order by total desc`;
  // `epiCodigo` (aditivo): la Web identifica la EPI por
  // código; antes adivinaba el slug desde el nombre y lo desconocido caía
  // en "Centro".
  return rows.map((r) => ({ zona: r.zona ?? 'Sin EPI', epiCodigo: r.epiCodigo ?? null, total: Number(r.total) }));
}