import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const queries = {
  porDia: db.$queryRaw`
    select to_char(ocurrido_en, 'YYYY-MM-DD') as dia, count(*)::bigint as total
    from hecho
    where ocurrido_en >= now() - make_interval(days => 6)
    group by 1 order by 1`,
  porTipo: db.$queryRaw`
    select th.label as tipo, count(h.id)::bigint as total
    from hecho h join tipo_hecho th on th.id = h.tipo_hecho_id
    group by th.label order by total desc`,
  porZona: db.$queryRaw`
    select e.nombre as zona, count(h.id)::bigint as total
    from hecho h left join epi e on e.id = h.epi_id
    group by e.nombre order by total desc`,
};

for (const [key, promise] of Object.entries(queries)) {
  try {
    await promise;
    console.log(`${key}: OK`);
  } catch (error) {
    const e = error;
    console.log(`${key}: ERROR -> ${e && e.message ? e.message : String(e)}`);
  }
}

await db.$disconnect();