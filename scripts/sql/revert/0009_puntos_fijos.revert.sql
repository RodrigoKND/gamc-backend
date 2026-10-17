-- Reversión de 0009_puntos_fijos.
-- Se DETIENE si hay guardias asignados a un punto fijo ahora mismo: hay que
-- retirarlos antes (desde la web) para no dejar asignaciones sin destino.
-- Las asignaciones ya cerradas pierden la referencia al punto (la columna se
-- elimina), pero conservan su punto en patrulla.poligono_geojson.
\if :{?reversion_entrega}
\else
BEGIN;
\endif

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM patrulla WHERE punto_fijo_id IS NOT NULL AND estado IN ('asignada','en_curso')) THEN
    RAISE EXCEPTION 'revert 0009: hay guardias asignados a puntos fijos; retíralos antes de revertir';
  END IF;
END $$;

DELETE FROM role_permission WHERE recurso = 'puntos_fijos';

DROP INDEX IF EXISTS ix_patrulla_punto_fijo_activa;
DROP INDEX IF EXISTS ux_ruta_ejecucion_punto_abierta;
ALTER TABLE patrulla DROP COLUMN IF EXISTS punto_fijo_id;
ALTER TABLE ruta_ejecucion DROP COLUMN IF EXISTS destino, DROP COLUMN IF EXISTS punto_fijo_id;

DROP TABLE IF EXISTS punto_fijo_version;
DROP TABLE IF EXISTS punto_fijo;

DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0009_puntos_fijos'; END IF; END $$;
\if :{?reversion_entrega}
\else
COMMIT;
\endif
