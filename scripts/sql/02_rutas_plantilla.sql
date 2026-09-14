-- =============================================================================
-- 02_rutas_plantilla.sql — 15 rutas plantilla (3 por EPI) con poligono GeoJSON
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 02_rutas_plantilla.sql
-- Idempotente: verifica nombre existente antes de insertar
-- =============================================================================
DO $$
DECLARE
  v_creado_por uuid := (SELECT id FROM "user" WHERE email='maria.rojas@cochabamba.bo');
  r record;
BEGIN
  -- 3 rutas por cada EPI — coordenadas reales Cochabamba (-17.39, -66.16)
  FOR r IN SELECT * FROM (VALUES
    ('EPI Norte — Ruta 1',          'Patrullaje preventivo norte',       'norte',          -17.370, -66.160, 0.004),
    ('EPI Norte — Ruta 2',          'Control comercial norte',           'norte',          -17.365, -66.158, 0.005),
    ('EPI Norte — Ruta 3',          'Ronda nocturna norte',              'norte',          -17.375, -66.162, 0.004),
    ('EPI Central — Ruta 1',        'Plaza principal y alrededores',     'central',        -17.393, -66.165, 0.004),
    ('EPI Central — Ruta 2',        'Terminal y mercado central',        'central',        -17.395, -66.168, 0.005),
    ('EPI Central — Ruta 3',        'Zona bancaria central',             'central',        -17.390, -66.162, 0.003),
    ('EPI Sud — Ruta 1',            'Patrullaje zona sud',               'sud',            -17.420, -66.170, 0.005),
    ('EPI Sud — Ruta 2',            'Control barrial sud',               'sud',            -17.425, -66.172, 0.004),
    ('EPI Sud — Ruta 3',            'Ronda perimetral sud',              'sud',            -17.415, -66.168, 0.004),
    ('EPI Coña Coña — Ruta 1',      'Coña Coña tramo 1',                 'cona_cona',      -17.380, -66.190, 0.004),
    ('EPI Coña Coña — Ruta 2',      'Coña Coña tramo 2',                 'cona_cona',      -17.385, -66.192, 0.005),
    ('EPI Coña Coña — Ruta 3',      'Coña Coña perimetro',               'cona_cona',      -17.378, -66.188, 0.003),
    ('EPI Centro Cercado — Ruta 1','Cercado historico',                 'centro_cercado', -17.395, -66.155, 0.004),
    ('EPI Centro Cercado — Ruta 2','Mercado cercado',                   'centro_cercado', -17.398, -66.152, 0.005),
    ('EPI Centro Cercado — Ruta 3','Zona residencial cercado',          'centro_cercado', -17.392, -66.158, 0.003)
  ) AS t(nombre, descripcion, epi_codigo, lat, lng, delta)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM ruta_plantilla WHERE nombre = r.nombre) THEN
      INSERT INTO ruta_plantilla (nombre, descripcion, epi_id, trazado, activo, creado_por)
      VALUES (
        r.nombre,
        r.descripcion,
        (SELECT id FROM epi WHERE codigo = r.epi_codigo),
        jsonb_build_object(
          'type', 'Polygon',
          'coordinates', jsonb_build_array(jsonb_build_array(
            jsonb_build_array(r.lng - r.delta, r.lat - r.delta),
            jsonb_build_array(r.lng + r.delta, r.lat - r.delta),
            jsonb_build_array(r.lng + r.delta, r.lat + r.delta),
            jsonb_build_array(r.lng - r.delta, r.lat + r.delta),
            jsonb_build_array(r.lng - r.delta, r.lat - r.delta)
          ))
        ),
        true,
        v_creado_por
      );
    END IF;
  END LOOP;
END $$;

SELECT epi.codigo as epi, count(*) as rutas FROM ruta_plantilla r JOIN epi ON epi.id=r.epi_id GROUP BY epi.codigo ORDER BY epi.codigo;
