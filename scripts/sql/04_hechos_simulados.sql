-- =============================================================================
-- 04_hechos_simulados.sql — 30 hechos distribuidos ultimos 7 dias
-- Cobertura: todos los niveles de riesgo, 3 estados, todos los EPIs
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 04_hechos_simulados.sql
-- =============================================================================
DO $$
DECLARE
  v_guardia uuid;
  v_tipo uuid;
  v_epi uuid;
  v_turno uuid;
  v_lat double precision;
  v_lng double precision;
  v_nivel nivel_riesgo;
  v_estado hecho_estado;
  i int;
  epi_cod text;
  epi_nombre text;
BEGIN
  FOR i IN 1..30 LOOP
    -- Guardia aleatorio activo
    SELECT id INTO v_guardia FROM guardia WHERE estado='activo' ORDER BY random() LIMIT 1;
    -- Tipo aleatorio
    SELECT id INTO v_tipo FROM tipo_hecho ORDER BY random() LIMIT 1;
    -- EPI aleatorio
    SELECT id, codigo, nombre INTO v_epi, epi_cod, epi_nombre FROM epi ORDER BY random() LIMIT 1;
    -- Turno del guardia si existe
    SELECT id INTO v_turno FROM turno WHERE guardia_id=v_guardia ORDER BY hora_inicio DESC LIMIT 1;

    SELECT
      CASE epi_cod WHEN 'norte' THEN -17.370 WHEN 'sud' THEN -17.420 WHEN 'cona_cona' THEN -17.380 WHEN 'centro_cercado' THEN -17.395 ELSE -17.393 END + (random()-0.5)*0.02,
      CASE epi_cod WHEN 'norte' THEN -66.160 WHEN 'sud' THEN -66.170 WHEN 'cona_cona' THEN -66.190 WHEN 'centro_cercado' THEN -66.155 ELSE -66.165 END + (random()-0.5)*0.02
    INTO v_lat, v_lng;

    v_nivel := (ARRAY['bajo','medio','alto','muy_alto'])[1+floor(random()*4)::int]::nivel_riesgo;
    v_estado := (ARRAY['reportado','en_revision','cerrado'])[1+floor(random()*3)::int]::hecho_estado;

    INSERT INTO hecho (turno_id, guardia_id, tipo_hecho_id, descripcion, nivel_riesgo, lat, lng, epi_id, direccion, ocurrido_en, estado)
    VALUES (
      v_turno,
      v_guardia,
      v_tipo,
      format('%s reportado en %s — caso sim #%s', (SELECT label FROM tipo_hecho WHERE id=v_tipo), epi_nombre, i),
      v_nivel,
      v_lat,
      v_lng,
      v_epi,
      format('Av. Sim %s, %s', i, epi_nombre),
      now() - (random()*7 || ' days')::interval,
      v_estado
    );

    -- Evidencia foto (picsum)
    INSERT INTO hecho_evidencia (hecho_id, url, tipo)
    VALUES (
      (SELECT id FROM hecho WHERE descripcion = format('%s reportado en %s — caso sim #%s', (SELECT label FROM tipo_hecho WHERE id=v_tipo), epi_nombre, i) ORDER BY reportado_en DESC LIMIT 1),
      format('https://picsum.photos/seed/gamc-hecho-%s/400/300', i),
      'foto'
    );
  END LOOP;
END $$;

SELECT 'hechos_total' as k, count(*) FROM hecho
UNION ALL SELECT 'reportado', count(*) FROM hecho WHERE estado='reportado'
UNION ALL SELECT 'en_revision', count(*) FROM hecho WHERE estado='en_revision'
UNION ALL SELECT 'cerrado', count(*) FROM hecho WHERE estado='cerrado'
UNION ALL SELECT 'ult_24h', count(*) FROM hecho WHERE ocurrido_en > now() - interval '24 hours';

SELECT epi.codigo as epi, count(*) as hechos, string_agg(DISTINCT hecho.nivel_riesgo::text, ', ') as niveles
FROM hecho JOIN epi ON epi.id=hecho.epi_id GROUP BY epi.codigo ORDER BY count(*) DESC;
