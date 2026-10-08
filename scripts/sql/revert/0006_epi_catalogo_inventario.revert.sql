-- Reversión de 0006_epi_catalogo_inventario (cambios/04 §2.4).
-- Restaura nombres y estado de las EPIs base, y elimina lo agregado.
-- Las EPIs nuevas solo se borran si nada las referencia; si hay datos
-- que ya las usan, la reversión se detiene para no perder información.
BEGIN;
DO $$
DECLARE n integer;
BEGIN
  SELECT (SELECT count(*) FROM guardia g JOIN epi e ON e.id = g.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
       + (SELECT count(*) FROM "user" u JOIN epi e ON e.id = u.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
       + (SELECT count(*) FROM hecho h JOIN epi e ON e.id = h.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
       + (SELECT count(*) FROM patrulla p JOIN epi e ON e.id = p.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
       + (SELECT count(*) FROM ruta_plantilla r JOIN epi e ON e.id = r.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
       + (SELECT count(*) FROM zona_critica_activa z JOIN epi e ON e.id = z.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))
    INTO n;
  IF n > 0 THEN RAISE EXCEPTION 'Reversión 0006 detenida: % registros usan Jaihuayco/Alalay Sud', n; END IF;
END $$;
DROP TABLE IF EXISTS modulo_policial;
DROP TABLE IF EXISTS epi_territorio;
DELETE FROM epi WHERE codigo IN ('jaihuayco','alalay_sud');
UPDATE epi SET nombre = 'EPI Norte' WHERE codigo = 'norte';
UPDATE epi SET nombre = 'EPI Central' WHERE codigo = 'central';
UPDATE epi SET nombre = 'EPI Sud' WHERE codigo = 'sud';
UPDATE epi SET nombre = 'EPI Coña Coña' WHERE codigo = 'cona_cona';
UPDATE epi SET activo = true WHERE codigo = 'centro_cercado';
ALTER TABLE epi DROP CONSTRAINT IF EXISTS ck_epi_color;
DROP INDEX IF EXISTS ux_epi_numero;
ALTER TABLE epi DROP COLUMN IF EXISTS numero, DROP COLUMN IF EXISTS nombre_oficial, DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS sede_lat, DROP COLUMN IF EXISTS sede_lng, DROP COLUMN IF EXISTS sede_direccion, DROP COLUMN IF EXISTS telefonos;
DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
  DELETE FROM _prisma_migrations WHERE migration_name = '0006_epi_catalogo_inventario'; END IF; END $$;
COMMIT;
