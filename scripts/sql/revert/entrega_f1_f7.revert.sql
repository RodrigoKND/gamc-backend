-- Reversión de la entrega F1–F7 (0012 → 0006, orden inverso).
-- Cada reversión es su propia transacción y se DETIENE si hay datos en uso
-- (horarios abiertos, programaciones automáticas, guardias en puntos fijos,
-- datos que ya usan las EPIs nuevas): el mensaje indica qué resolver antes
-- de reintentar.
--
-- Uso, desde la raíz del backend:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/revert/entrega_f1_f7.revert.sql
-- Antes de revertir, volver a publicar el backend y la web anteriores.

\set ON_ERROR_STOP on
\ir 0012_plazo_incorporacion.revert.sql
\ir 0011_asignacion_automatica.revert.sql
\ir 0010_programacion_rutas.revert.sql
\ir 0009_puntos_fijos.revert.sql
\ir 0008_segmentacion_epi.revert.sql
\ir 0007_ruta_ejecucion.revert.sql
\ir 0006_epi_catalogo_inventario.revert.sql
