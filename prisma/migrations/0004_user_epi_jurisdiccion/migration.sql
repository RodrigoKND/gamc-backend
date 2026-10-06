-- Jurisdicción por EPI (2026-10-05): el Operador/Admin solo puede crear,
-- asignar o cancelar rutas dentro de su EPI. super_admin queda sin EPI
-- (sin restricción). Polígonos de cada EPI: scripts/sql/06_epi_poligonos.sql.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS epi_id uuid REFERENCES epi(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_user_epi ON "user" (epi_id);
