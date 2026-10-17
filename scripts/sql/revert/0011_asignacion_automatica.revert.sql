-- Reversión de 0011_asignacion_automatica.
-- Se DETIENE si hay programaciones en modo automático o horarios
-- automáticos abiertos: hay que pasarlas a manual (o eliminarlas) y cancelar
-- esos horarios desde la web antes de revertir. Se pierde el historial de
-- intentos automáticos (tabla asignacion_automatica_intento).
\if :{?reversion_entrega}
\else
BEGIN;
\endif

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ruta_programacion WHERE modo = 'automatica' AND estado <> 'archivada') THEN
    RAISE EXCEPTION 'revert 0011: hay programaciones automáticas; pásalas a manual antes de revertir';
  END IF;
  IF EXISTS (SELECT 1 FROM ruta_ejecucion WHERE asignacion_modo = 'automatica' AND estado IN ('pendiente','activa','incompleta')) THEN
    RAISE EXCEPTION 'revert 0011: hay horarios automáticos abiertos; cancélalos antes de revertir';
  END IF;
END $$;

DROP TABLE IF EXISTS asignacion_automatica_intento;

DROP INDEX IF EXISTS ix_ruta_ejecucion_auto;
ALTER TABLE ruta_ejecucion DROP CONSTRAINT IF EXISTS ck_ruta_ejecucion_asignacion_modo;
ALTER TABLE ruta_ejecucion
  DROP COLUMN IF EXISTS auto_ultimo,
  DROP COLUMN IF EXISTS auto_intentos,
  DROP COLUMN IF EXISTS auto_proximo_intento,
  DROP COLUMN IF EXISTS auto_radio_m,
  DROP COLUMN IF EXISTS asignacion_modo;

ALTER TABLE ruta_programacion DROP CONSTRAINT IF EXISTS ck_ruta_programacion_auto_radio;
ALTER TABLE ruta_programacion DROP CONSTRAINT IF EXISTS ck_ruta_programacion_radio;
ALTER TABLE ruta_programacion
  DROP COLUMN IF EXISTS radio_max_m;

DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0011_asignacion_automatica'; END IF; END $$;
\if :{?reversion_entrega}
\else
COMMIT;
\endif
