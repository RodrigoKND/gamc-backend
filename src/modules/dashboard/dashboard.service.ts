import { db } from '@infra/database';

// KPIs y series para el dashboard. Los históricos usan $queryRaw (agrupación
// por día efectiva); los KPIs en vivo van por conteos simples de Prisma.

function hoyInicio(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
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

export async function hechosPorDia(dias = 7) {
  const rows = await db.$queryRaw<DiaRow[]>`
    select to_char(ocurrido_en, 'YYYY-MM-DD') as dia, count(*)::bigint as total
    from hecho
    where ocurrido_en >= now() - make_interval(days => ${Math.max(1, Math.min(30, dias))}::int)
    group by 1
    order by 1`;
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