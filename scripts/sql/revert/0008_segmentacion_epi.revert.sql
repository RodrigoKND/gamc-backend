-- Reversión de 0008_segmentacion_epi.
-- Restaura hecho.epi_id y mandado.epi_id desde el respaldo y el
-- permiso guardias.editar del Operador; quita lo agregado.
-- Los hechos creados DESPUÉS de 0008 conservan la EPI calculada por su
-- ubicación (no tienen valor anterior que restaurar).
\if :{?reversion_entrega}
\else
BEGIN;
\endif

ALTER TABLE hecho DISABLE TRIGGER trg_hecho_updated;
UPDATE hecho h SET epi_id = r.epi_anterior
FROM hecho_epi_reclasificacion r
WHERE r.recurso = 'hecho' AND r.lote = '0008' AND r.registro_id = h.id;
ALTER TABLE hecho ENABLE TRIGGER trg_hecho_updated;

UPDATE role_permission p SET puede_editar = c.valor_anterior
FROM role r, permiso_cambio_registro c
WHERE r.id = p.role_id AND r.codigo = c.rol AND p.recurso = c.recurso AND c.campo = 'puede_editar' AND c.lote = '0008';

DELETE FROM role_permission WHERE recurso IN ('dashboard','jurisdiccion_usuarios');

DROP TABLE IF EXISTS permiso_cambio_registro;
DROP TABLE IF EXISTS guardia_ubicacion_actual;
DROP TABLE IF EXISTS hecho_epi_reclasificacion;

DROP INDEX IF EXISTS ix_hecho_epi_pendiente;
DROP INDEX IF EXISTS ix_mandado_epi;
ALTER TABLE hecho DROP CONSTRAINT IF EXISTS ck_hecho_epi_metodo;
ALTER TABLE hecho DROP CONSTRAINT IF EXISTS ck_hecho_epi_estado;
ALTER TABLE hecho DROP COLUMN IF EXISTS epi_metodo, DROP COLUMN IF EXISTS epi_estado,
  DROP COLUMN IF EXISTS epi_territorio_version, DROP COLUMN IF EXISTS epi_clasificado_en;
ALTER TABLE mandado DROP CONSTRAINT IF EXISTS ck_mandado_epi_metodo;
ALTER TABLE mandado DROP CONSTRAINT IF EXISTS ck_mandado_epi_estado;
ALTER TABLE mandado DROP COLUMN IF EXISTS epi_id, DROP COLUMN IF EXISTS epi_metodo, DROP COLUMN IF EXISTS epi_estado,
  DROP COLUMN IF EXISTS epi_territorio_version, DROP COLUMN IF EXISTS epi_clasificado_en;

DROP FUNCTION IF EXISTS fn_gamc_clasificar_punto(double precision, double precision);
DROP FUNCTION IF EXISTS fn_gamc_punto_en_geojson(double precision, double precision, jsonb);
DROP FUNCTION IF EXISTS fn_gamc_en_anillo(double precision, double precision, jsonb);

DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0008_segmentacion_epi'; END IF; END $$;
\if :{?reversion_entrega}
\else
COMMIT;
\endif
