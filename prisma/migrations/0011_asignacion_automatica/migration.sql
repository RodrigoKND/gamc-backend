-- F6 — Asignación automática de horarios programados.
-- Reversión: scripts/sql/revert/0011_asignacion_automatica.revert.sql
--
-- Solo aditivo: columnas nuevas (nullable o con valor por defecto), una
-- tabla nueva e índices nuevos. No modifica datos existentes: las
-- programaciones actuales quedan en modo manual (su valor actual).
-- Idempotente: se puede volver a aplicar sin duplicar nada.
--
-- Modelo: una programación en modo 'automatica' lleva su radio inicial de
-- búsqueda (3 km, lo fija el sistema; nunca "cualquier distancia"). Al
-- abrir cada horario el planificador copia ese radio en la ejecución y le asigna guardias libres, cercanos y aptos con el mismo motor
-- de F2; si no encuentra a nadie, amplía el radio y reintenta hasta el fin.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.ruta_programacion') IS NULL THEN
    RAISE EXCEPTION '0011: aplicar antes 0010_programacion_rutas';
  END IF;
END $$;

-- 1) Parámetros de la programación automática -------------------------------
--    radio_max_m: radio INICIAL de búsqueda (el del horario crece solo).
ALTER TABLE ruta_programacion ADD COLUMN IF NOT EXISTS radio_max_m integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_programacion_radio') THEN
    ALTER TABLE ruta_programacion ADD CONSTRAINT ck_ruta_programacion_radio CHECK (radio_max_m IS NULL OR radio_max_m BETWEEN 100 AND 20000);
  END IF;
  -- Automática sin radio = "cualquier distancia": no se permite.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_programacion_auto_radio') THEN
    ALTER TABLE ruta_programacion ADD CONSTRAINT ck_ruta_programacion_auto_radio CHECK (modo <> 'automatica' OR radio_max_m IS NOT NULL);
  END IF;
END $$;

-- 2) Copia en la ejecución y estado de los intentos -------------------------
--    asignacion_modo: modo del horario (copia de la programación al abrirlo).
--    NULL en las que no salen de una programación.
--    auto_radio_m: radio de búsqueda actual del horario.
--    auto_proximo_intento: cuándo toca el siguiente intento; reclamarlo con
--    la fila bloqueada evita que dos servidores intenten a la vez.
--    auto_ultimo: resumen del último intento (lo muestra la agenda) y, si un
--    operador está eligiendo el reemplazo a mano, hasta cuándo se le espera.
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS asignacion_modo text;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS auto_radio_m integer;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS auto_proximo_intento timestamptz;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS auto_intentos integer NOT NULL DEFAULT 0;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS auto_ultimo jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ruta_ejecucion_asignacion_modo') THEN
    ALTER TABLE ruta_ejecucion ADD CONSTRAINT ck_ruta_ejecucion_asignacion_modo CHECK (asignacion_modo IS NULL OR asignacion_modo IN ('manual','automatica'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_ruta_ejecucion_auto ON ruta_ejecucion (auto_proximo_intento)
  WHERE asignacion_modo = 'automatica' AND estado IN ('pendiente','incompleta');

-- 3) Historial de intentos (explicabilidad) ----------------------------------
--    Una fila por intento que asignó a alguien, el primero de cada horario y
--    los que fallaron. Guarda a quién eligió (con su distancia) y a quién
--    descartó y por qué. Los reintentos sin novedad solo actualizan
--    ruta_ejecucion.auto_ultimo (no llenan la tabla).
CREATE TABLE IF NOT EXISTS asignacion_automatica_intento (
  id           bigserial PRIMARY KEY,
  ejecucion_id uuid NOT NULL REFERENCES ruta_ejecucion(id),
  intento      integer NOT NULL,
  ejecutado_en timestamptz NOT NULL DEFAULT now(),
  asignados    integer NOT NULL DEFAULT 0,
  faltan       integer NOT NULL DEFAULT 0,
  candidatos   integer NOT NULL DEFAULT 0,
  elegidos     jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluidos    jsonb NOT NULL DEFAULT '[]'::jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS ix_asignacion_automatica_intento_ejecucion ON asignacion_automatica_intento (ejecucion_id, id DESC);
-- Radio de búsqueda usado en ese intento (crece solo si no encuentra a nadie).
ALTER TABLE asignacion_automatica_intento ADD COLUMN IF NOT EXISTS radio_m integer;

-- 4) Verificación posterior --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ruta_programacion' AND column_name = 'radio_max_m')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ruta_ejecucion' AND column_name = 'auto_proximo_intento') THEN
    RAISE EXCEPTION '0011: faltan columnas de la asignación automática';
  END IF;
  IF EXISTS (SELECT 1 FROM ruta_programacion WHERE modo = 'automatica' AND radio_max_m IS NULL) THEN
    RAISE EXCEPTION '0011: hay programaciones automáticas sin radio';
  END IF;
END $$;
