-- F2 — Motor de asignación.
-- Reversión: scripts/sql/revert/0007_ruta_ejecucion.revert.sql
--
-- Aditivo, salvo las excepciones aprobadas:
--   · índice único "una asignación activa por guardia" (si ya hay
--     duplicados, la migración ABORTA con la lista; no los corrige sola);
--   · v_patrulla_vigente con las mismas columnas y la vigencia correcta.
-- Idempotente: se puede volver a aplicar sin duplicar nada.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
DECLARE dup text;
BEGIN
  IF to_regclass('public.patrulla') IS NULL OR to_regclass('public.ruta_plantilla') IS NULL THEN
    RAISE EXCEPTION '0007: faltan las tablas patrulla / ruta_plantilla';
  END IF;
  IF to_regclass('public.epi_territorio') IS NULL THEN
    RAISE EXCEPTION '0007: aplicar antes 0006_epi_catalogo_inventario';
  END IF;
  SELECT string_agg(guardia_id::text || ' (' || n || ')', ', ') INTO dup
  FROM (SELECT guardia_id, count(*) n FROM patrulla WHERE estado IN ('asignada','en_curso') GROUP BY guardia_id HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '0007: guardias con más de una patrulla activa (resolver a mano antes de migrar): %', dup;
  END IF;
END $$;

-- 1) Tipo y parámetros de la ruta (biblioteca) -------------------------------
--    establecida = oficial (policía) · guardada = recurrente · dinamica =
--    dibujada para una sola asignación. duracion_min: cuánto dura una
--    asignación de esta ruta (null = sin límite, la cierra el usuario).
ALTER TABLE ruta_plantilla ADD COLUMN IF NOT EXISTS tipo text;
ALTER TABLE ruta_plantilla ADD COLUMN IF NOT EXISTS duracion_min integer;
ALTER TABLE ruta_plantilla ADD COLUMN IF NOT EXISTS capacidad smallint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_plantilla_tipo') THEN
    ALTER TABLE ruta_plantilla ADD CONSTRAINT ck_ruta_plantilla_tipo CHECK (tipo IS NULL OR tipo IN ('establecida','guardada','dinamica'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_plantilla_duracion') THEN
    ALTER TABLE ruta_plantilla ADD CONSTRAINT ck_ruta_plantilla_duracion CHECK (duracion_min IS NULL OR duracion_min BETWEEN 15 AND 10080);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_plantilla_capacidad') THEN
    ALTER TABLE ruta_plantilla ADD CONSTRAINT ck_ruta_plantilla_capacidad CHECK (capacidad IS NULL OR capacidad BETWEEN 1 AND 50);
  END IF;
END $$;
-- Rellena solo las columnas NUEVAS de las rutas existentes: las reutilizables
-- pasan a "guardada" (12 h por defecto); las de una sola asignación, a "dinámica".
UPDATE ruta_plantilla SET tipo = CASE WHEN activo THEN 'guardada' ELSE 'dinamica' END WHERE tipo IS NULL;
UPDATE ruta_plantilla SET duracion_min = 720 WHERE tipo IN ('guardada','establecida') AND duracion_min IS NULL;

-- 2) Ejecución: cada asignación concreta de una ruta ---------------------------
--    Agrupa a los guardias que la cumplen juntos. Cancelar una ejecución no
--    toca otras de la misma plantilla; el trazado queda copiado (snapshot),
--    así editar la plantilla no cambia lo ya asignado.
CREATE TABLE IF NOT EXISTS ruta_ejecucion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_plantilla_id uuid REFERENCES ruta_plantilla(id),
  epi_id            uuid REFERENCES epi(id),
  tipo              text NOT NULL CHECK (tipo IN ('establecida','guardada','dinamica','legado')),
  nombre            text NOT NULL,
  descripcion       text,
  modalidad         text NOT NULL CHECK (modalidad IN ('coche','moto','a_pie','punto_fijo','oficina')),
  capacidad         smallint NOT NULL CHECK (capacidad BETWEEN 1 AND 50),
  trazado           jsonb,
  unidad            text,
  origen            text NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','programada','automatica','legado')),
  estado            text NOT NULL DEFAULT 'activa' CHECK (estado IN ('pendiente','activa','incompleta','finalizada','cancelada')),
  inicio            timestamptz NOT NULL DEFAULT now(),
  fin               timestamptz,
  motivo_cierre     text,
  cerrada_en        timestamptz,
  cerrada_por       uuid REFERENCES "user"(id),
  creado_por        uuid REFERENCES "user"(id),
  creado_por_tipo   text NOT NULL DEFAULT 'user' CHECK (creado_por_tipo IN ('user','sistema')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (fin IS NULL OR fin > inicio)
);
CREATE INDEX IF NOT EXISTS ix_ruta_ejecucion_vigentes ON ruta_ejecucion (estado, fin) WHERE estado IN ('pendiente','activa','incompleta');
CREATE INDEX IF NOT EXISTS ix_ruta_ejecucion_plantilla ON ruta_ejecucion (ruta_plantilla_id);

-- 3) Columnas nuevas en patrulla (una fila = un guardia en una ejecución) -----
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS ejecucion_id uuid REFERENCES ruta_ejecucion(id);
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS modalidad text;
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS motivo_cierre text;
-- Estado respecto a la ruta, calculado por el servidor en cada ping GPS.
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS estado_ruta text;
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS distancia_ruta_m integer;
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS estado_ruta_en timestamptz;
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS incorporada_en timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_patrulla_estado_ruta') THEN
    ALTER TABLE patrulla ADD CONSTRAINT ck_patrulla_estado_ruta CHECK (estado_ruta IS NULL OR estado_ruta IN ('incorporandose','en_ruta','advertencia','alerta'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_patrulla_modalidad') THEN
    ALTER TABLE patrulla ADD CONSTRAINT ck_patrulla_modalidad CHECK (modalidad IS NULL OR modalidad IN ('coche','moto','a_pie','punto_fijo','oficina'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_patrulla_ejecucion ON patrulla (ejecucion_id);
-- Única defensa real contra dos asignaciones simultáneas del mismo guardia.
CREATE UNIQUE INDEX IF NOT EXISTS ux_patrulla_guardia_activa ON patrulla (guardia_id) WHERE estado IN ('asignada','en_curso');

-- 4) Idempotencia: repetir la misma petición (doble clic, reintento) no duplica.
CREATE TABLE IF NOT EXISTS operacion_idempotente (
  clave      uuid PRIMARY KEY,
  actor_id   uuid,
  operacion  text NOT NULL,
  huella     text NOT NULL,
  resultado  jsonb NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- 5) Ejecución para las patrullas ACTIVAS existentes (las históricas quedan con
--    ejecucion_id = null). Se agrupan por plantilla + fecha, como las mostraba
--    la web. Las de rutas guardadas vencen a las 12 h de asignadas.
DO $$
DECLARE g record; eid uuid; modal text;
BEGIN
  FOR g IN
    SELECT p.ruta_plantilla_id rp, p.fecha, min(p.created_at) inicio, array_agg(p.id) ids, count(*) n,
           (array_agg(p.epi_id))[1] epi, (array_agg(p.nombre))[1] nombre, (array_agg(p.asignado_por))[1] autor
    FROM patrulla p
    WHERE p.estado IN ('asignada','en_curso') AND p.ejecucion_id IS NULL
    GROUP BY p.ruta_plantilla_id, p.fecha, CASE WHEN p.ruta_plantilla_id IS NULL THEN p.id END
  LOOP
    INSERT INTO ruta_ejecucion (ruta_plantilla_id, epi_id, tipo, nombre, descripcion, modalidad, capacidad, trazado,
                                origen, estado, inicio, fin, creado_por)
    SELECT g.rp, coalesce(r.epi_id, g.epi), coalesce(r.tipo, 'legado'), coalesce(r.nombre, g.nombre, 'Ruta'), r.descripcion,
           coalesce(r.modalidad, 'coche'), 1, r.trazado, 'legado', 'activa', g.inicio,
           CASE WHEN r.duracion_min IS NOT NULL THEN g.inicio + make_interval(mins => r.duracion_min) END, g.autor
    FROM (SELECT 1) x LEFT JOIN ruta_plantilla r ON r.id = g.rp
    RETURNING id, modalidad INTO eid, modal;
    UPDATE ruta_ejecucion SET capacidad = greatest(g.n::int, CASE modal WHEN 'coche' THEN 12 WHEN 'moto' THEN 2 WHEN 'a_pie' THEN 3 WHEN 'punto_fijo' THEN 2 ELSE 8 END)
      WHERE id = eid;
    UPDATE patrulla p SET ejecucion_id = eid, modalidad = e.modalidad FROM ruta_ejecucion e WHERE e.id = eid AND p.id = ANY (g.ids);
  END LOOP;
END $$;

-- 6) v_patrulla_vigente: mismas columnas; vigencia por la ventana de la
--    ejecución [inicio, fin) y, para filas sin ejecución, por la fecha LOCAL de
--    Bolivia (antes current_date en UTC: las rutas "desaparecían" a las 20:00).
CREATE OR REPLACE VIEW v_patrulla_vigente AS
SELECT p.id,
    p.guardia_id,
    p.ruta_plantilla_id,
    p.epi_id,
    p.asignado_por,
    p.estado,
    p.fecha,
    p.hora_inicio_prevista,
    p.notas,
    p.nombre,
    p.descripcion,
    p.poligono_geojson,
    p.turno_id,
    p.iniciada_en,
    p.completada_en,
    p.created_at,
    p.updated_at,
    coalesce(e.trazado, r.trazado) AS trazado,
    r.nombre AS ruta_nombre
FROM patrulla p
  LEFT JOIN ruta_plantilla r ON r.id = p.ruta_plantilla_id
  LEFT JOIN ruta_ejecucion e ON e.id = p.ejecucion_id
WHERE p.estado = ANY (ARRAY['asignada'::patrulla_estado, 'en_curso'::patrulla_estado])
  AND (
    (p.ejecucion_id IS NOT NULL AND e.estado IN ('activa','incompleta') AND e.inicio <= now() AND (e.fin IS NULL OR e.fin > now()))
    OR (p.ejecucion_id IS NULL AND p.fecha = (now() AT TIME ZONE 'America/La_Paz')::date)
  );

-- 7) Permisos nuevos (filas nuevas; las existentes no se tocan) ---------------
INSERT INTO role_permission (role_id, recurso, puede_ver, puede_crear, puede_editar, puede_eliminar)
SELECT r.id, v.recurso, v.ver, v.crear, v.editar, v.eliminar
FROM (VALUES
  ('super_admin',        'sos',                true,  false, true,  false),
  ('admin',              'sos',                true,  false, false, false),
  ('operador_monitoreo', 'sos',                true,  false, true,  false),
  ('super_admin',        'rutas_establecidas', true,  true,  true,  true),
  ('admin',              'rutas_establecidas', true,  true,  true,  false),
  ('operador_monitoreo', 'rutas_establecidas', true,  true,  true,  false)
) AS v(rol, recurso, ver, crear, editar, eliminar)
JOIN role r ON r.codigo = v.rol
ON CONFLICT (role_id, recurso) DO NOTHING;

-- 8) Verificación posterior --------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM patrulla WHERE estado IN ('asignada','en_curso') AND ejecucion_id IS NULL) THEN
    RAISE EXCEPTION '0007: quedaron patrullas activas sin ejecución';
  END IF;
  IF (SELECT count(*) FROM role_permission WHERE recurso IN ('sos','rutas_establecidas')) < 6 THEN
    RAISE EXCEPTION '0007: faltan permisos sos / rutas_establecidas';
  END IF;
END $$;
