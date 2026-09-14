-- =============================================================================
-- 99_verificacion.sql — Queries para verificar que el frontend vera datos
-- Ejecuta: psql -U postgres -d gamc_seguridad -f 99_verificacion.sql
-- Estos SELECT replican exactamente lo que consumen los endpoints:
--   GET /api/guardias, /api/mapas/ubicaciones, /api/dashboard/kpi, /api/mapas/zonas
-- =============================================================================

-- 1) Buscador de guardia por nombre/ci/epi (lo usa GuardiasView)
SELECT '== BUSCADOR GUARDIA: q=quispe ==' as test;
SELECT primer_nombre, apellido_paterno, ci, (SELECT codigo FROM epi WHERE id=guardia.epi_id) as epi, estado_operativo
FROM guardia WHERE primer_nombre ILIKE '%quispe%' OR apellido_paterno ILIKE '%quispe%' OR ci ILIKE '%quispe%' LIMIT 5;

SELECT '== FILTRO POR ZONA: EPI norte ==' as test;
SELECT g.primer_nombre, g.apellido_paterno, e.codigo FROM guardia g LEFT JOIN epi e ON e.id=g.epi_id WHERE e.codigo='norte' LIMIT 5;

-- 2) Lo que ve el Mapa de Patrullaje en Vivo (v_guardia_ubicacion_actual + bateria)
SELECT '== MAPA: UBICACIONES CON BATERIA (endpoint /api/mapas/ubicaciones) ==' as test;
SELECT g.nombre, g.estado_operativo, tel.bateria_pct, tel.lat, tel.lng, tel.capturado_en, turno.hora_inicio as turno_inicio
FROM guardia g
JOIN LATERAL (SELECT bateria_pct, lat, lng, capturado_en, turno_id FROM guardia_telemetria WHERE guardia_id=g.id ORDER BY capturado_en DESC LIMIT 1) tel ON true
LEFT JOIN turno ON turno.id=tel.turno_id
WHERE g.estado='activo' AND g.estado_operativo != 'fuera_de_servicio'
ORDER BY tel.capturado_en DESC LIMIT 10;

-- Bateria baja (<20%) — debe aparecer con alerta en frontend
SELECT '== BATERIA BAJA (<20%) ==' as test;
SELECT g.nombre, tel.bateria_pct FROM guardia g JOIN LATERAL (SELECT bateria_pct FROM guardia_telemetria WHERE guardia_id=g.id ORDER BY capturado_en DESC LIMIT 1) tel ON true WHERE tel.bateria_pct < 20;

-- 3) Dashboard KPIs
SELECT '== DASHBOARD KPIs ==' as test;
SELECT count(*) as hechos_hoy FROM hecho WHERE ocurrido_en >= date_trunc('day', now());
SELECT count(*) as en_revision FROM hecho WHERE estado='en_revision';
SELECT count(DISTINCT guardia_id) as guardias_en_servicio FROM turno WHERE estado='en_servicio';
SELECT count(*) as sos_pendientes FROM guardia_telemetria WHERE es_sos AND coalesce(sos_estado,'pendiente')='pendiente';
SELECT 'hechos_por_zona' as serie; SELECT epi.codigo, count(*) FROM hecho JOIN epi ON epi.id=hecho.epi_id GROUP BY epi.codigo ORDER BY count(*) DESC;
SELECT 'hechos_por_tipo' as serie; SELECT th.label, count(*) FROM hecho JOIN tipo_hecho th ON th.id=hecho.tipo_hecho_id GROUP BY th.label ORDER BY count(*) DESC;

-- 4) Heatmap (endpoint /api/mapas/heatmap)
SELECT '== HEATMAP DENSIDAD (ultimos 7 dias) ==' as test;
SELECT lat, lng, nivel_riesgo FROM hecho WHERE ocurrido_en > now() - interval '7 days' ORDER BY ocurrido_en DESC LIMIT 5;

-- 5) Zonas criticas / mapa de calor por EPI
SELECT '== ZONAS CRITICAS VIGENTES ==' as test;
SELECT epi.codigo, z.centro_lat, z.centro_lng, z.cantidad_hechos, z.nivel_riesgo FROM zona_critica_activa z JOIN epi ON epi.id=z.epi_id WHERE vigente=true ORDER BY z.cantidad_hechos DESC;

-- 6) Patrullas vigentes (asignar rutas)
SELECT '== PATRULLAS VIGENTES HOY ==' as test;
SELECT p.nombre, p.estado, g.nombre as guardia, epi.codigo as epi FROM patrulla p JOIN guardia g ON g.id=p.guardia_id LEFT JOIN epi ON epi.id=p.epi_id WHERE p.fecha=current_date ORDER BY p.created_at DESC LIMIT 5;

-- 7) Rutas plantilla
SELECT '== RUTAS PLANTILLA ==' as test;
SELECT nombre, (SELECT codigo FROM epi WHERE id=ruta_plantilla.epi_id) as epi, trazado IS NOT NULL as tiene_trazado FROM ruta_plantilla WHERE activo=true ORDER BY nombre LIMIT 5;
