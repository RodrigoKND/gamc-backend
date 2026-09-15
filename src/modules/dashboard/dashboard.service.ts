import { db } from '@infra/database';

// KPIs y series para el dashboard. Los históricos usan $queryRaw (agrupación
// por día efectiva); los KPIs en vivo van por conteos simples de Prisma.

function hoyInicio(): Date {
  // Bolivia UTC-4 — usar America/La_Paz para que "hoy" coincida con lo que ve el guardia en la web (no UTC del server Render)
  const ahoraLaPaz = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/La_Paz' }));
  ahoraLaPaz.setHours(0, 0, 0, 0);
  // Convertir de vuelta a UTC para la query (Prisma espera Date en UTC)
  const offsetMs = 4 * 60 * 60 * 1000;
  return new Date(ahoraLaPaz.getTime() + offsetMs);
}

function hoyLaPazISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' }); // YYYY-MM-DD
}

export async function kpis() {
  const inicioHoy = hoyInicio();
  const [hechosHoy, hechosRevision, guardiasServicio, sosPendientes] = await Promise.all([
    db.hecho.count({ where: { ocurridoEn: { gte: inicioHoy } } }),
    db.hecho.count({ where: { estado: 'en_revision' } }),
    db.turno.findMany({ where: { estado: 'en_servicio' }, select: { guardiaId: true } }),
    db.guardiaTelemetria.findMany({
      where: { esSos: true, sosEstado: 'pendiente' },
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
interface ZonaRow { zona: string | null; total: bigint }

// generate_series + LEFT JOIN en vez de un GROUP BY simple: un GROUP BY puro
// nunca produce una fila para un día sin hechos, así que la gráfica del
// dashboard omitía esos días en vez de mostrarlos en 0 (un día realmente
// tranquilo se veía igual que un día sin datos todavía).
export async function hechosPorDia(dias = 7) {
  const n = Math.max(1, Math.min(30, dias));
  // Usar fecha de Bolivia para que el gráfico de 7 días coincida con "Hechos Hoy" y con lo que ve el guardia
  const rows = await db.$queryRaw<DiaRow[]>`
    select to_char(d.dia, 'YYYY-MM-DD') as dia, coalesce(count(h.id), 0)::bigint as total
    from generate_series((now() AT TIME ZONE 'America/La_Paz')::date - (${n}::int - 1), (now() AT TIME ZONE 'America/La_Paz')::date, interval '1 day') as d(dia)
    left join hecho h on (h.ocurrido_en AT TIME ZONE 'America/La_Paz')::date = d.dia
    group by d.dia
    order by d.dia`;
  return rows.map((r) => ({ dia: r.dia, total: Number(r.total) }));
}

export async function hechosPorTipo() {
  const rows = await db.$queryRaw<TipoRow[]>`
    select th.label as tipo, count(h.id)::bigint as total
    from hecho h
    join tipo_hecho th on th.id = h.tipo_hecho_id
    group by th.label
    order by total desc`;
  return rows.map((r) => ({ tipo: r.tipo, total: Number(r.total) }));
}

export async function hechosPorZona() {
  const rows = await db.$queryRaw<ZonaRow[]>`
    select e.nombre as zona, count(h.id)::bigint as total
    from hecho h
    left join epi e on e.id = h.epi_id
    group by e.nombre
    order by total desc`;
  return rows.map((r) => ({ zona: r.zona ?? 'Sin EPI', total: Number(r.total) }));
}