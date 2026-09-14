import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const dir = join(process.cwd(), 'scripts', 'sql');
const files = ['01_guardias_simulados.sql','02_rutas_plantilla.sql','03_turnos_y_telemetria.sql','04_hechos_simulados.sql','05_patrullas_y_zonas.sql'];

for (const f of files) {
  const p = join(dir, f);
  if (!existsSync(p)) { console.error('Falta', p); continue; }
  const sql = readFileSync(p, 'utf8');
  console.log(`\n=== Ejecutando ${f} (${sql.length} chars) ===`);
  try {
    // Prisma puede ejecutar bloques DO $$ en una sola llamada
    await db.$executeRawUnsafe(sql);
    console.log(`OK ${f}`);
  } catch (e) {
    // Algunos archivos tienen SELECTs finales que $executeRawUnsafe no permite con retorno
    // Reintentamos separando por statements y usando $queryRaw para SELECTs
    console.warn(`$executeRawUnsafe falló para ${f}, probando split:`, e.message?.slice(0,300));
    const statements = sql.split(/;\s*\n/).filter(s=>s.trim().length>0);
    for (let i=0;i<statements.length;i++) {
      const stmt = statements[i].trim();
      if (!stmt) continue;
      // Detecta SELECT verificación al final
      if (/^\s*SELECT/i.test(stmt)) {
        try {
          const rows = await db.$queryRawUnsafe(stmt);
          console.log(`[SELECT ${i}]`, JSON.stringify(rows).slice(0,800));
        } catch (qe) { console.warn(`SELECT error ${i}:`, qe.message.slice(0,200)); }
      } else {
        try { await db.$executeRawUnsafe(stmt+';'); } catch (ee) { console.warn(`stmt ${i} error:`, ee.message.slice(0,300)); }
      }
    }
    console.log(`OK (split) ${f}`);
  }
}

console.log('\n=== Verificación final ===');
const v = await db.$queryRawUnsafe(`
  SELECT 'guardias' as tabla, count(*)::int as c FROM guardia
  UNION ALL SELECT 'turnos_en_servicio', count(*)::int FROM turno WHERE estado='en_servicio'
  UNION ALL SELECT 'telemetria', count(*)::int FROM guardia_telemetria
  UNION ALL SELECT 'hechos', count(*)::int FROM hecho
  UNION ALL SELECT 'zonas_vigentes', count(*)::int FROM zona_critica_activa WHERE vigente=true
  UNION ALL SELECT 'rutas', count(*)::int FROM ruta_plantilla WHERE activo=true
  UNION ALL SELECT 'patrullas_hoy', count(*)::int FROM patrulla WHERE fecha=current_date
`);
console.table(v);

// Muestra estados operativos tras seed
const ops = await db.$queryRawUnsafe(`SELECT estado_operativo as estado, count(*)::int as c FROM guardia GROUP BY estado_operativo ORDER BY c DESC`);
console.log('estados_operativos', ops);

const lowBat = await db.$queryRawUnsafe(`
  SELECT g.ci, g.nombre, tel.bateria_pct as bateria, tel.capturado_en
  FROM guardia g JOIN LATERAL (SELECT bateria_pct, capturado_en FROM guardia_telemetria WHERE guardia_id=g.id ORDER BY capturado_en DESC LIMIT 1) tel ON true
  WHERE tel.bateria_pct < 20
  LIMIT 5
`);
console.log('bateria_baja', lowBat);

await db.$disconnect();
console.log('\nSeed simulado COMPLETO. Refresca /dashboard y /mapas.');
