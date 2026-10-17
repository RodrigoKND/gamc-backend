-- Reversión de 0012_plazo_incorporacion (F7).
-- Se pierde solo la hora límite de las patrullas: las que ya pasaron a
-- advertencia/alerta por plazo vuelven a "incorporándose" en su próximo ping
-- con el código anterior. No borra patrullas ni estados.
BEGIN;

DROP INDEX IF EXISTS ix_patrulla_incorporacion_limite;
ALTER TABLE patrulla DROP COLUMN IF EXISTS incorporacion_limite;

DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0012_plazo_incorporacion'; END IF; END $$;
COMMIT;
