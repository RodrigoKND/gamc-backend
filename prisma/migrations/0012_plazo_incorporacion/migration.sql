-- F7 — Plazo para incorporarse a la ruta.
-- Reversión: scripts/sql/revert/0012_plazo_incorporacion.revert.sql
--
-- Solo aditivo: una columna nullable y un índice parcial. No modifica datos
-- existentes: las patrullas en curso sin plazo lo reciben en su próximo ping
-- GPS (lo calcula el servidor). Idempotente.
--
-- Modelo: al pasar a "en curso" el servidor fija incorporacion_limite =
-- ahora + tiempo de viaje pesimista desde la última posición del guardia
-- hasta su ruta. Si vence sin que haya llegado (incorporada_en IS NULL), deja
-- de estar "incorporándose" y pasa a advertencia o alerta según su distancia.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'patrulla' AND column_name = 'incorporada_en') THEN
    RAISE EXCEPTION '0012: aplicar antes 0007_ruta_ejecucion';
  END IF;
END $$;

-- 1) Hora límite -------------------------------------------------------------
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS incorporacion_limite timestamptz;

-- 2) Barrido del planificador: solo las que siguen incorporándose -----------
CREATE INDEX IF NOT EXISTS ix_patrulla_incorporacion_limite ON patrulla (incorporacion_limite)
  WHERE estado = 'en_curso' AND incorporada_en IS NULL AND incorporacion_limite IS NOT NULL;

-- 3) Verificación posterior --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'patrulla' AND column_name = 'incorporacion_limite') THEN
    RAISE EXCEPTION '0012: falta patrulla.incorporacion_limite';
  END IF;
END $$;
