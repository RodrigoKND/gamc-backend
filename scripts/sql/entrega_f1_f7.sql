-- Entrega F1–F7: aplica las migraciones 0006–0012 en orden.
-- Para servidores donde el esquema se aplica con SQL (sin `prisma migrate deploy`).
-- Requiere las migraciones 0001–0005. Cada migración comprueba sus
-- precondiciones y es idempotente: si 0006 ya estaba aplicada, no cambia nada.
--
-- Uso, desde la raíz del backend y con la base RESPALDADA:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/entrega_f1_f7.sql
-- (-1 = una sola transacción: si algo falla, no queda nada aplicado.)
--
-- No registra filas en _prisma_migrations: si luego se usa
-- `prisma migrate deploy` en esa base, volverá a aplicarlas sin efecto.
-- Reversión: scripts/sql/revert/entrega_f1_f7.revert.sql

\set ON_ERROR_STOP on
\ir ../../prisma/migrations/0006_epi_catalogo_inventario/migration.sql
\ir ../../prisma/migrations/0007_ruta_ejecucion/migration.sql
\ir ../../prisma/migrations/0008_segmentacion_epi/migration.sql
\ir ../../prisma/migrations/0009_puntos_fijos/migration.sql
\ir ../../prisma/migrations/0010_programacion_rutas/migration.sql
\ir ../../prisma/migrations/0011_asignacion_automatica/migration.sql
\ir ../../prisma/migrations/0012_plazo_incorporacion/migration.sql
