-- 07_rutas_backfill_epi.sql — asigna EPI a las ruta_plantilla creadas antes
-- de la jurisdicción por EPI (2026-10-05), que quedaron con epi_id NULL.
-- Sin EPI, un Operador/Admin no puede reutilizar la plantilla (mapas.service
-- exige que la ruta sea de su EPI). Toma la EPI más frecuente entre las
-- patrullas de cada ruta. Idempotente: solo toca filas con epi_id NULL.
UPDATE ruta_plantilla r
SET epi_id = sub.epi_id, updated_at = now()
FROM (
  SELECT DISTINCT ON (ruta_plantilla_id) ruta_plantilla_id, epi_id
  FROM patrulla
  WHERE ruta_plantilla_id IS NOT NULL AND epi_id IS NOT NULL
  GROUP BY ruta_plantilla_id, epi_id
  ORDER BY ruta_plantilla_id, count(*) DESC
) sub
WHERE r.id = sub.ruta_plantilla_id AND r.epi_id IS NULL;
