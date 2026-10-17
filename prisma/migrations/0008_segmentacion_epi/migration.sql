-- F3 — Segmentación por EPI, EPI actual del guardia y reclasificación.
-- Reversión: scripts/sql/revert/0008_segmentacion_epi.revert.sql
--
-- Aditivo, salvo las excepciones aprobadas:
--   · hecho.epi_id se reclasifica por la ubicación del propio hecho.
--     ANTES de tocarlo, el valor anterior queda copiado en
--     hecho_epi_reclasificacion (revertir = restaurar desde ahí).
--   · al Operador se le quita guardias.editar (el SOS ya tiene su
--     permiso propio `sos` desde 0007); el valor anterior queda en
--     permiso_cambio_registro.
-- Idempotente: se puede volver a aplicar sin duplicar nada ni reclasificar
-- de nuevo lo ya clasificado.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.epi_territorio') IS NULL THEN
    RAISE EXCEPTION '0008: aplicar antes 0006_epi_catalogo_inventario';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM role_permission WHERE recurso = 'sos') THEN
    RAISE EXCEPTION '0008: falta el permiso sos (aplicar antes 0007_ruta_ejecucion)';
  END IF;
  IF (SELECT count(*) FROM epi_territorio WHERE vigente) = 0 THEN
    RAISE EXCEPTION '0008: no hay territorios vigentes para clasificar';
  END IF;
END $$;

-- 1) Geometría en SQL (sin PostGIS) -------------------------------------------
--    Misma regla que el backend (src/modules/epis/geometria.ts): punto en
--    polígono por cruce de rayos, exterior menos huecos, Polygon o
--    MultiPolygon, sin tolerancia. Se usa para reclasificar en la migración.
CREATE OR REPLACE FUNCTION fn_gamc_en_anillo(x double precision, y double precision, ring jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  n int := jsonb_array_length(ring);
  i int; j int;
  xi double precision; yi double precision; xj double precision; yj double precision;
  dentro boolean := false;
BEGIN
  IF n < 3 THEN RETURN false; END IF;
  j := n - 1;
  FOR i IN 0 .. n - 1 LOOP
    xi := (ring -> i ->> 0)::double precision; yi := (ring -> i ->> 1)::double precision;
    xj := (ring -> j ->> 0)::double precision; yj := (ring -> j ->> 1)::double precision;
    IF ((yi > y) <> (yj > y)) AND (x < (xj - xi) * (y - yi) / (yj - yi) + xi) THEN
      dentro := NOT dentro;
    END IF;
    j := i;
  END LOOP;
  RETURN dentro;
END $$;

CREATE OR REPLACE FUNCTION fn_gamc_punto_en_geojson(x double precision, y double precision, geo jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  polys jsonb; poly jsonb; k int; hueco boolean;
BEGIN
  IF geo ->> 'type' = 'Polygon' THEN polys := jsonb_build_array(geo -> 'coordinates');
  ELSIF geo ->> 'type' = 'MultiPolygon' THEN polys := geo -> 'coordinates';
  ELSE RETURN false;
  END IF;
  FOR poly IN SELECT value FROM jsonb_array_elements(polys) LOOP
    IF jsonb_array_length(poly) > 0 AND fn_gamc_en_anillo(x, y, poly -> 0) THEN
      hueco := false;
      FOR k IN 1 .. jsonb_array_length(poly) - 1 LOOP
        IF fn_gamc_en_anillo(x, y, poly -> k) THEN hueco := true; EXIT; END IF;
      END LOOP;
      IF NOT hueco THEN RETURN true; END IF;
    END IF;
  END LOOP;
  RETURN false;
END $$;

-- EPI operativa (activa y con territorio vigente) que contiene el punto.
-- Orden reproducible: número oficial y código (igual que clasificarPunto).
-- Fuera de todas → fuera_cobertura (nunca "la más cercana"); en un
-- solapamiento → ambigua con la primera, marcada para revisión.
CREATE OR REPLACE FUNCTION fn_gamc_clasificar_punto(x double precision, y double precision)
RETURNS TABLE (epi_id uuid, estado text, territorio_version int) LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT e.id, t.version,
           row_number() OVER (ORDER BY coalesce(e.numero, 999), e.codigo) AS rn,
           count(*) OVER () AS total
    FROM epi e
    JOIN epi_territorio t ON t.epi_id = e.id AND t.vigente
    WHERE e.activo AND fn_gamc_punto_en_geojson(x, y, t.poligono)
  )
  SELECT c.id, CASE WHEN c.total = 1 THEN 'asignada' ELSE 'ambigua' END, c.version FROM c WHERE c.rn = 1
  UNION ALL
  SELECT NULL::uuid, 'fuera_cobertura', NULL::int WHERE NOT EXISTS (SELECT 1 FROM c)
$$;

-- 2) Clasificación territorial de hechos y mandados (columnas nuevas) ----------
--    epi_metodo: ubicacion (por coordenadas) | manual (supervisión) |
--    legado (heredado de la cuenta del guardia, antes de F3).
--    epi_estado: asignada | ambigua | fuera_cobertura. Ambigua o fuera de
--    cobertura = pendiente de revisión en la bandeja del Super Admin.
ALTER TABLE hecho ADD COLUMN IF NOT EXISTS epi_metodo text;
ALTER TABLE hecho ADD COLUMN IF NOT EXISTS epi_estado text;
ALTER TABLE hecho ADD COLUMN IF NOT EXISTS epi_territorio_version integer;
ALTER TABLE hecho ADD COLUMN IF NOT EXISTS epi_clasificado_en timestamptz;

ALTER TABLE mandado ADD COLUMN IF NOT EXISTS epi_id uuid REFERENCES epi(id);
ALTER TABLE mandado ADD COLUMN IF NOT EXISTS epi_metodo text;
ALTER TABLE mandado ADD COLUMN IF NOT EXISTS epi_estado text;
ALTER TABLE mandado ADD COLUMN IF NOT EXISTS epi_territorio_version integer;
ALTER TABLE mandado ADD COLUMN IF NOT EXISTS epi_clasificado_en timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_hecho_epi_metodo') THEN
    ALTER TABLE hecho ADD CONSTRAINT ck_hecho_epi_metodo CHECK (epi_metodo IS NULL OR epi_metodo IN ('ubicacion','manual','legado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_hecho_epi_estado') THEN
    ALTER TABLE hecho ADD CONSTRAINT ck_hecho_epi_estado CHECK (epi_estado IS NULL OR epi_estado IN ('asignada','ambigua','fuera_cobertura'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mandado_epi_metodo') THEN
    ALTER TABLE mandado ADD CONSTRAINT ck_mandado_epi_metodo CHECK (epi_metodo IS NULL OR epi_metodo IN ('ubicacion','manual','legado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mandado_epi_estado') THEN
    ALTER TABLE mandado ADD CONSTRAINT ck_mandado_epi_estado CHECK (epi_estado IS NULL OR epi_estado IN ('asignada','ambigua','fuera_cobertura'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_mandado_epi ON mandado (epi_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_hecho_epi_pendiente ON hecho (ocurrido_en DESC) WHERE epi_estado IN ('ambigua','fuera_cobertura');

-- 3) Respaldo de la reclasificación -----------------------------------------
CREATE TABLE IF NOT EXISTS hecho_epi_reclasificacion (
  id                 bigserial PRIMARY KEY,
  recurso            text NOT NULL CHECK (recurso IN ('hecho','mandado')),
  registro_id        uuid NOT NULL,
  epi_anterior       uuid,
  epi_nueva          uuid,
  estado             text NOT NULL,
  territorio_version integer,
  lote               text NOT NULL,
  reclasificado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recurso, registro_id, lote)
);

-- 4) Reclasificación por ubicación -------------------------------------------
--    Solo lo que aún no tiene clasificación (epi_metodo IS NULL): volver a
--    aplicar la migración no reclasifica dos veces. Los fuera de cobertura
--    quedan SIN EPI (solo los ve supervisión global, en su bandeja): no se
--    les inventa la "más cercana".
DROP TABLE IF EXISTS _clasif_hecho;
CREATE TEMP TABLE _clasif_hecho AS
  SELECT h.id, h.epi_id AS anterior, c.epi_id AS nueva, c.estado, c.territorio_version
  FROM hecho h CROSS JOIN LATERAL fn_gamc_clasificar_punto(h.lng, h.lat) c
  WHERE h.epi_metodo IS NULL;

INSERT INTO hecho_epi_reclasificacion (recurso, registro_id, epi_anterior, epi_nueva, estado, territorio_version, lote)
SELECT 'hecho', id, anterior, nueva, estado, territorio_version, '0008' FROM _clasif_hecho
ON CONFLICT (recurso, registro_id, lote) DO NOTHING;

-- Sin tocar updated_at: es una corrección de clasificación, no una edición del hecho.
ALTER TABLE hecho DISABLE TRIGGER trg_hecho_updated;
UPDATE hecho h
   SET epi_id = c.nueva,
       epi_metodo = 'ubicacion',
       epi_estado = c.estado,
       epi_territorio_version = c.territorio_version,
       epi_clasificado_en = now()
  FROM _clasif_hecho c
 WHERE h.id = c.id AND h.epi_metodo IS NULL;
ALTER TABLE hecho ENABLE TRIGGER trg_hecho_updated;

DROP TABLE IF EXISTS _clasif_mandado;
CREATE TEMP TABLE _clasif_mandado AS
  SELECT m.id, m.epi_id AS anterior, c.epi_id AS nueva, c.estado, c.territorio_version
  FROM mandado m CROSS JOIN LATERAL fn_gamc_clasificar_punto(m.lng, m.lat) c
  WHERE m.epi_metodo IS NULL;

INSERT INTO hecho_epi_reclasificacion (recurso, registro_id, epi_anterior, epi_nueva, estado, territorio_version, lote)
SELECT 'mandado', id, anterior, nueva, estado, territorio_version, '0008' FROM _clasif_mandado
ON CONFLICT (recurso, registro_id, lote) DO NOTHING;

UPDATE mandado m
   SET epi_id = c.nueva,
       epi_metodo = 'ubicacion',
       epi_estado = c.estado,
       epi_territorio_version = c.territorio_version,
       epi_clasificado_en = now()
  FROM _clasif_mandado c
 WHERE m.id = c.id AND m.epi_metodo IS NULL;

DROP TABLE IF EXISTS _clasif_hecho;
DROP TABLE IF EXISTS _clasif_mandado;

-- 5) EPI actual del guardia (tabla nueva) ------------------------------------------
--    Una fila por guardia con su ÚLTIMA posición válida y la EPI en la que
--    está. Evita escribir la fila `guardia` en cada GPS. guardia.epi_id queda
--    como dato legado (lo lee la app móvil) y ya no decide nada.
CREATE TABLE IF NOT EXISTS guardia_ubicacion_actual (
  guardia_id         uuid PRIMARY KEY REFERENCES guardia(id) ON DELETE CASCADE,
  telemetria_id      bigint,
  lat                double precision NOT NULL,
  lng                double precision NOT NULL,
  precision_m        numeric(8,2),
  bateria_pct        integer,
  capturado_en       timestamptz NOT NULL,
  recibido_en        timestamptz NOT NULL DEFAULT now(),
  epi_id             uuid REFERENCES epi(id),
  epi_estado         text NOT NULL CHECK (epi_estado IN ('asignada','ambigua','fuera_cobertura')),
  territorio_version integer,
  epi_desde          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_guardia_ubicacion_epi ON guardia_ubicacion_actual (epi_id);

INSERT INTO guardia_ubicacion_actual (guardia_id, telemetria_id, lat, lng, precision_m, bateria_pct, capturado_en, recibido_en,
                                      epi_id, epi_estado, territorio_version, epi_desde)
SELECT t.guardia_id, t.id, t.lat, t.lng, t.precision_m, t.bateria_pct, t.capturado_en, t.recibido_en,
       c.epi_id, c.estado, c.territorio_version, t.capturado_en
FROM guardia g
JOIN LATERAL (
  SELECT id, guardia_id, lat, lng, precision_m, bateria_pct, capturado_en, recibido_en
  FROM guardia_telemetria WHERE guardia_id = g.id ORDER BY capturado_en DESC, id DESC LIMIT 1
) t ON true
CROSS JOIN LATERAL fn_gamc_clasificar_punto(t.lng, t.lat) c
ON CONFLICT (guardia_id) DO NOTHING;

-- 6) Permisos nuevos (recursos nuevos) y retiro de guardias.editar al Operador ---------
--    dashboard: acceso a estadísticas (antes colgaba de `reportes`, que
--    también tiene el Operador). jurisdiccion_usuarios: cambiar la EPI de una
--    cuenta web, solo Super Admin (antes bastaba usuarios.editar, que tiene
--    el Admin, incluso sobre su propia cuenta).
INSERT INTO role_permission (role_id, recurso, puede_ver, puede_crear, puede_editar, puede_eliminar)
SELECT r.id, v.recurso, v.ver, v.crear, v.editar, v.eliminar
FROM (VALUES
  ('super_admin',        'dashboard',             true,  false, false, false),
  ('admin',              'dashboard',             true,  false, false, false),
  ('operador_monitoreo', 'dashboard',             false, false, false, false),
  ('super_admin',        'jurisdiccion_usuarios', true,  false, true,  false),
  ('admin',              'jurisdiccion_usuarios', false, false, false, false),
  ('operador_monitoreo', 'jurisdiccion_usuarios', false, false, false, false)
) AS v(rol, recurso, ver, crear, editar, eliminar)
JOIN role r ON r.codigo = v.rol
ON CONFLICT (role_id, recurso) DO NOTHING;

-- Registro de cambios puntuales a permisos existentes (para revertir).
CREATE TABLE IF NOT EXISTS permiso_cambio_registro (
  id            bigserial PRIMARY KEY,
  rol           text NOT NULL,
  recurso       text NOT NULL,
  campo         text NOT NULL,
  valor_anterior boolean,
  valor_nuevo   boolean,
  lote          text NOT NULL,
  cambiado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rol, recurso, campo, lote)
);

INSERT INTO permiso_cambio_registro (rol, recurso, campo, valor_anterior, valor_nuevo, lote)
SELECT 'operador_monitoreo', 'guardias', 'puede_editar', p.puede_editar, false, '0008'
FROM role_permission p JOIN role r ON r.id = p.role_id
WHERE r.codigo = 'operador_monitoreo' AND p.recurso = 'guardias'
ON CONFLICT (rol, recurso, campo, lote) DO NOTHING;

UPDATE role_permission p SET puede_editar = false
FROM role r
WHERE r.id = p.role_id AND r.codigo = 'operador_monitoreo' AND p.recurso = 'guardias' AND p.puede_editar;

-- 7) Verificación posterior ----------------------------------------------------------
DO $$
DECLARE sin_clasificar int; sin_respaldo int;
BEGIN
  SELECT count(*) INTO sin_clasificar FROM hecho WHERE epi_metodo IS NULL;
  IF sin_clasificar > 0 THEN RAISE EXCEPTION '0008: % hechos quedaron sin clasificar', sin_clasificar; END IF;
  SELECT count(*) INTO sin_respaldo FROM hecho h
   WHERE h.epi_metodo = 'ubicacion'
     AND NOT EXISTS (SELECT 1 FROM hecho_epi_reclasificacion r WHERE r.recurso = 'hecho' AND r.registro_id = h.id);
  IF sin_respaldo > 0 THEN RAISE EXCEPTION '0008: % hechos reclasificados sin respaldo', sin_respaldo; END IF;
  IF (SELECT count(*) FROM mandado WHERE epi_metodo IS NULL) > 0 THEN
    RAISE EXCEPTION '0008: hay mandados sin clasificar';
  END IF;
  IF (SELECT count(*) FROM role_permission WHERE recurso IN ('dashboard','jurisdiccion_usuarios')) < 6 THEN
    RAISE EXCEPTION '0008: faltan permisos dashboard / jurisdiccion_usuarios';
  END IF;
END $$;
