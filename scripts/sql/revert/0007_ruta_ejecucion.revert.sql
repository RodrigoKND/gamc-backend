-- Reversión de 0007_ruta_ejecucion.
-- Restaura la vista original, quita permisos/tablas/columnas agregadas.
-- Las patrullas creadas mientras 0007 estuvo activa se conservan (solo pierden
-- el vínculo a su ejecución y el estado de desvío).
BEGIN;
CREATE OR REPLACE VIEW v_patrulla_vigente AS
SELECT p.id, p.guardia_id, p.ruta_plantilla_id, p.epi_id, p.asignado_por, p.estado, p.fecha,
       p.hora_inicio_prevista, p.notas, p.nombre, p.descripcion, p.poligono_geojson, p.turno_id,
       p.iniciada_en, p.completada_en, p.created_at, p.updated_at, r.trazado, r.nombre AS ruta_nombre
FROM patrulla p
  LEFT JOIN ruta_plantilla r ON r.id = p.ruta_plantilla_id
WHERE p.estado = ANY (ARRAY['asignada'::patrulla_estado, 'en_curso'::patrulla_estado]) AND p.fecha = CURRENT_DATE;
DELETE FROM role_permission WHERE recurso IN ('sos','rutas_establecidas');
DROP INDEX IF EXISTS ux_patrulla_guardia_activa;
DROP INDEX IF EXISTS ix_patrulla_ejecucion;
ALTER TABLE patrulla DROP CONSTRAINT IF EXISTS ck_patrulla_estado_ruta;
ALTER TABLE patrulla DROP CONSTRAINT IF EXISTS ck_patrulla_modalidad;
ALTER TABLE patrulla DROP COLUMN IF EXISTS ejecucion_id, DROP COLUMN IF EXISTS modalidad, DROP COLUMN IF EXISTS motivo_cierre,
  DROP COLUMN IF EXISTS estado_ruta, DROP COLUMN IF EXISTS distancia_ruta_m, DROP COLUMN IF EXISTS estado_ruta_en,
  DROP COLUMN IF EXISTS incorporada_en;
DROP TABLE IF EXISTS operacion_idempotente;
DROP TABLE IF EXISTS ruta_ejecucion;
ALTER TABLE ruta_plantilla DROP CONSTRAINT IF EXISTS ck_ruta_plantilla_tipo;
ALTER TABLE ruta_plantilla DROP CONSTRAINT IF EXISTS ck_ruta_plantilla_duracion;
ALTER TABLE ruta_plantilla DROP CONSTRAINT IF EXISTS ck_ruta_plantilla_capacidad;
ALTER TABLE ruta_plantilla DROP COLUMN IF EXISTS tipo, DROP COLUMN IF EXISTS duracion_min, DROP COLUMN IF EXISTS capacidad;
DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0007_ruta_ejecucion'; END IF; END $$;
COMMIT;
