-- =============================================================================
-- 05_patrullas_y_zonas.sql — Patrullas vigentes (hoy) + zonas criticas
-- Patrullas: 6 asignadas/en_curso para probar asignar rutas y mapa
-- Zonas: recalculadas agrupando hechos ultimos 7 dias por EPI
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 05_patrullas_y_zonas.sql
-- =============================================================================

-- 1) Patrullas vigentes (fecha = hoy) — evita duplicado por guardia/dia
DO $$
DECLARE
  g record;
  v_ruta uuid;
  v_trazado jsonb;
  v_asignado uuid := (SELECT id FROM "user" WHERE email='maria.rojas@cochabamba.bo');
  v_count int := 0;
BEGIN
  FOR g IN SELECT id, epi_id FROM guardia WHERE estado='activo' ORDER BY random() LIMIT 6 LOOP
    IF EXISTS (SELECT 1 FROM patrulla WHERE guardia_id=g.id AND fecha = current_date) THEN CONTINUE; END IF;
    SELECT id, trazado INTO v_ruta, v_trazado FROM ruta_plantilla WHERE (epi_id = g.epi_id OR g.epi_id IS NULL) ORDER BY random() LIMIT 1;
    INSERT INTO patrulla (guardia_id, ruta_plantilla_id, epi_id, asignado_por, estado, fecha, nombre, descripcion, poligono_geojson, iniciada_en)
    VALUES (
      g.id,
      v_ruta,
      g.epi_id,
      v_asignado,
      (CASE WHEN random() > 0.5 THEN 'asignada' ELSE 'en_curso' END)::patrulla_estado,
      current_date,
      coalesce((SELECT nombre FROM ruta_plantilla WHERE id=v_ruta), format('Patrulla sim %s', v_count+1)),
      'Ruta asignada por script simulado',
      coalesce(v_trazado, '{"type":"Polygon","coordinates":[[[-66.165,-17.39],[-66.16,-17.39],[-66.16,-17.395],[-66.165,-17.395],[-66.165,-17.39]]]}'::jsonb),
      now() - (random()*2 || ' hours')::interval
    );
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Patrullas creadas: %', v_count;
END $$;

-- 2) Zonas criticas — invalida vigentes y recalcula por EPI (ventana 7 dias)
UPDATE zona_critica_activa SET vigente=false WHERE vigente=true;

DO $$
DECLARE
  epi_row record;
  v_lat double precision;
  v_lng double precision;
  v_cant int;
  v_nivel nivel_riesgo;
BEGIN
  FOR epi_row IN SELECT id, codigo FROM epi LOOP
    SELECT count(*), avg(lat), avg(lng) INTO v_cant, v_lat, v_lng
    FROM hecho WHERE epi_id=epi_row.id AND ocurrido_en > now() - interval '7 days';
    IF v_cant = 0 OR v_lat IS NULL THEN CONTINUE; END IF;

    -- Nivel predominante: muy_alto(4) > alto(3) > medio(2) > bajo(1)
    SELECT nivel_riesgo INTO v_nivel
    FROM hecho WHERE epi_id=epi_row.id AND ocurrido_en > now() - interval '7 days'
    GROUP BY nivel_riesgo ORDER BY CASE nivel_riesgo WHEN 'muy_alto' THEN 4 WHEN 'alto' THEN 3 WHEN 'medio' THEN 2 ELSE 1 END DESC, count(*) DESC LIMIT 1;

    INSERT INTO zona_critica_activa (epi_id, centro_lat, centro_lng, radio_m, cantidad_hechos, nivel_riesgo, ventana_desde, ventana_hasta, vigente)
    VALUES (epi_row.id, v_lat, v_lng, 500, v_cant, v_nivel, now() - interval '7 days', now(), true);
  END LOOP;
END $$;

-- Verificacion
SELECT 'patrullas_hoy' as k, count(*) FROM patrulla WHERE fecha=current_date
UNION ALL SELECT 'en_curso', count(*) FROM patrulla WHERE estado='en_curso' AND fecha=current_date
UNION ALL SELECT 'asignada', count(*) FROM patrulla WHERE estado='asignada' AND fecha=current_date
UNION ALL SELECT 'zonas_vigentes', count(*) FROM zona_critica_activa WHERE vigente=true;

SELECT epi.codigo as epi, z.cantidad_hechos, z.nivel_riesgo, z.centro_lat, z.centro_lng
FROM zona_critica_activa z JOIN epi ON epi.id=z.epi_id WHERE vigente=true ORDER BY z.cantidad_hechos DESC;
