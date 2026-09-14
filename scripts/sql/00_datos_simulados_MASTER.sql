-- =============================================================================
-- 00_datos_simulados_MASTER.sql — Master que ejecuta todos los scripts en orden
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 00_datos_simulados_MASTER.sql
-- O desde gamc-api: npm run db:seed  &&  psql $DATABASE_URL -f scripts/sql/00_datos_simulados_MASTER.sql
-- =============================================================================
\i 01_guardias_simulados.sql
\i 02_rutas_plantilla.sql
\i 03_turnos_y_telemetria.sql
\i 04_hechos_simulados.sql
\i 05_patrullas_y_zonas.sql

-- Resumen final
SELECT '=== RESUMEN GAMC DATOS SIMULADOS ===' as info;
SELECT 'guardias' as tabla, count(*) FROM guardia
UNION ALL SELECT 'turnos', count(*) FROM turno
UNION ALL SELECT 'telemetria', count(*) FROM guardia_telemetria
UNION ALL SELECT 'hechos', count(*) FROM hecho
UNION ALL SELECT 'rutas_plantilla', count(*) FROM ruta_plantilla
UNION ALL SELECT 'patrullas', count(*) FROM patrulla
UNION ALL SELECT 'zonas_vigentes', count(*) FROM zona_critica_activa WHERE vigente=true;
