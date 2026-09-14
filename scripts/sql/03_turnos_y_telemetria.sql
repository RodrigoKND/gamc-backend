-- =============================================================================
-- 03_turnos_y_telemetria.sql — Turnos en_servicio + telemetria con bateria
-- Crea 1 turno abierto por cada guardia en_servicio/emergencia + 3 puntos GPS
-- Bateria: 2 guardias con bateria baja (12% y 18%) para probar alertas
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 03_turnos_y_telemetria.sql
-- =============================================================================

-- 1) Turnos en_servicio (respeta ux_turno_abierto_por_guardia — 1 por guardia)
DO $$
DECLARE
  g record;
  v_turno uuid;
  v_lat double precision;
  v_lng double precision;
BEGIN
  FOR g IN SELECT id, epi_id, estado_operativo FROM guardia WHERE estado='activo' AND estado_operativo IN ('en_servicio','emergencia') LOOP
    IF EXISTS (SELECT 1 FROM turno WHERE guardia_id=g.id AND estado='en_servicio') THEN
      CONTINUE;
    END IF;
    -- Coordenada base segun EPI
    SELECT
      CASE (SELECT codigo FROM epi WHERE id=g.epi_id)
        WHEN 'norte' THEN -17.370 WHEN 'sud' THEN -17.420 WHEN 'cona_cona' THEN -17.380 WHEN 'centro_cercado' THEN -17.395 ELSE -17.393
      END,
      CASE (SELECT codigo FROM epi WHERE id=g.epi_id)
        WHEN 'norte' THEN -66.160 WHEN 'sud' THEN -66.170 WHEN 'cona_cona' THEN -66.190 WHEN 'centro_cercado' THEN -66.155 ELSE -66.165
      END
    INTO v_lat, v_lng;

    v_lat := v_lat + (random()-0.5)*0.015;
    v_lng := v_lng + (random()-0.5)*0.015;

    INSERT INTO turno (guardia_id, estado, selfie_inicio_url, lat_inicio, lng_inicio, hora_inicio)
    VALUES (g.id, 'en_servicio', 'https://example.com/selfie.jpg', v_lat, v_lng, now() - (random()*3 || ' hours')::interval)
    RETURNING id INTO v_turno;
  END LOOP;
END $$;

-- 2) Telemetria: 3 puntos por turno (bateria, precision, velocidad, sos)
--    Usa IDs de turno recien creados + captura reciente (now - 0/90/180s)
DO $$
DECLARE
  t record;
  g_op text;
  base_lat double precision;
  base_lng double precision;
  i int;
  v_bat int;
  v_es_sos boolean;
BEGIN
  FOR t IN SELECT turno.id as turno_id, turno.guardia_id, guardia.estado_operativo, guardia.epi_id FROM turno JOIN guardia ON guardia.id=turno.guardia_id WHERE turno.estado='en_servicio' LOOP
    -- Si ya tiene telemetria reciente, salta para idempotencia
    IF EXISTS (SELECT 1 FROM guardia_telemetria WHERE turno_id=t.turno_id AND capturado_en > now() - interval '10 minutes') THEN
      CONTINUE;
    END IF;
    SELECT
      CASE (SELECT codigo FROM epi WHERE id=t.epi_id)
        WHEN 'norte' THEN -17.370 WHEN 'sud' THEN -17.420 WHEN 'cona_cona' THEN -17.380 WHEN 'centro_cercado' THEN -17.395 ELSE -17.393
      END,
      CASE (SELECT codigo FROM epi WHERE id=t.epi_id)
        WHEN 'norte' THEN -66.160 WHEN 'sud' THEN -66.170 WHEN 'cona_cona' THEN -66.190 WHEN 'centro_cercado' THEN -66.155 ELSE -66.165
      END
    INTO base_lat, base_lng;

    v_es_sos := (t.estado_operativo = 'emergencia');

    FOR i IN 0..2 LOOP
      -- Fuerza bateria baja en los 2 primeros guardias para demo de alertas
      IF t.guardia_id = (SELECT id FROM guardia WHERE ci='7564321') AND i=0 THEN v_bat := 12;
      ELSIF t.guardia_id = (SELECT id FROM guardia WHERE ci='8123456') AND i=0 THEN v_bat := 18;
      ELSIF i=0 AND random() < 0.15 THEN v_bat := (10 + random()*15)::int; -- 10-25% ocasional
      ELSE v_bat := (25 + random()*75)::int; -- 25-100%
      END IF;

      INSERT INTO guardia_telemetria (guardia_id, turno_id, lat, lng, precision_m, velocidad_mps, bateria_pct, es_sos, sos_estado, capturado_en)
      VALUES (
        t.guardia_id,
        t.turno_id,
        base_lat + (random()-0.5)*0.01,
        base_lng + (random()-0.5)*0.01,
        (5 + random()*15)::numeric(8,2),
        (random()*10)::numeric(8,2),
        v_bat,
        v_es_sos,
        CASE WHEN v_es_sos THEN 'pendiente' ELSE NULL END,
        now() - (i*90 || ' seconds')::interval - (random()*30 || ' seconds')::interval
      );
    END LOOP;
  END LOOP;
END $$;

-- Verificacion
SELECT 'turnos_en_servicio' as k, count(*) FROM turno WHERE estado='en_servicio'
UNION ALL
SELECT 'telemetria_total', count(*) FROM guardia_telemetria
UNION ALL
SELECT 'bateria_baja_<20%', count(*) FROM guardia_telemetria WHERE bateria_pct < 20
UNION ALL
SELECT 'sos_pendientes', count(*) FROM guardia_telemetria WHERE es_sos AND coalesce(sos_estado,'pendiente')='pendiente';

-- Ultima posicion por guardia (lo que ve el mapa)
SELECT g.ci, g.nombre, g.estado_operativo, tel.bateria_pct, tel.lat, tel.lng, tel.capturado_en
FROM guardia g JOIN LATERAL (
  SELECT bateria_pct, lat, lng, capturado_en FROM guardia_telemetria WHERE guardia_id=g.id ORDER BY capturado_en DESC LIMIT 1
) tel ON true
WHERE g.estado='activo'
ORDER BY tel.bateria_pct ASC LIMIT 10;
