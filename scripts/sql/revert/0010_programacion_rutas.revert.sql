-- Reversión de 0010_programacion_rutas.
-- Se DETIENE si hay horarios programados abiertos ahora mismo (pendientes o
-- con guardias): hay que cancelarlos antes desde la web. Las ejecuciones ya
-- cerradas que salieron de una programación se conservan, pero pierden la
-- referencia a su programación y horario (las columnas se eliminan).
\if :{?reversion_entrega}
\else
BEGIN;
\endif

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ruta_ejecucion WHERE programacion_id IS NOT NULL AND estado IN ('pendiente','activa','incompleta')) THEN
    RAISE EXCEPTION 'revert 0010: hay horarios programados abiertos; cancélalos antes de revertir';
  END IF;
END $$;

DELETE FROM role_permission WHERE recurso = 'programacion_rutas';

DROP INDEX IF EXISTS ix_ruta_ejecucion_programacion;
DROP INDEX IF EXISTS ux_ruta_ejecucion_ventana;
ALTER TABLE ruta_ejecucion
  DROP COLUMN IF EXISTS apertura,
  DROP COLUMN IF EXISTS programacion_version,
  DROP COLUMN IF EXISTS fecha_local,
  DROP COLUMN IF EXISTS ventana_id,
  DROP COLUMN IF EXISTS programacion_id;

DROP TABLE IF EXISTS planificador_registro;
DROP TABLE IF EXISTS planificador_estado;
DROP TABLE IF EXISTS ruta_programacion_ventana;
DROP TABLE IF EXISTS ruta_programacion;

DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0010_programacion_rutas'; END IF; END $$;
\if :{?reversion_entrega}
\else
COMMIT;
\endif
