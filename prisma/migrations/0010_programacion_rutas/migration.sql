-- F5 — Programación manual de rutas.
-- Reversión: scripts/sql/revert/0010_programacion_rutas.revert.sql
--
-- Solo aditivo: tablas nuevas, columnas nuevas nullable, índices nuevos y
-- filas nuevas de permisos. No modifica datos existentes.
-- Idempotente: se puede volver a aplicar sin duplicar nada.
--
-- Modelo: una PROGRAMACIÓN dice qué se cubre (una ruta de la biblioteca o un
-- punto fijo) y en qué vigencia; sus VENTANAS dicen qué días, a qué hora,
-- cuánto dura y cuántos guardias. El planificador del servidor abre cada
-- ventana como una ejecución "pendiente" 15 min antes de su inicio; el
-- operador le asigna guardias con el mismo motor de F2/F4.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.punto_fijo') IS NULL THEN
    RAISE EXCEPTION '0010: aplicar antes 0009_puntos_fijos';
  END IF;
END $$;

-- 1) Programación -------------------------------------------------------------
--    Exactamente un objetivo: una ruta de la biblioteca (predeterminada o
--    guardada) o un punto fijo (raíz). Las fechas de vigencia son fechas
--    LOCALES de inicio de cada ventana (un turno 22:00–06:00 del domingo
--    pertenece al domingo). modo: 'automatica' queda para F6.
CREATE TABLE IF NOT EXISTS ruta_programacion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            text NOT NULL,
  descripcion       text,
  epi_id            uuid NOT NULL REFERENCES epi(id),
  ruta_plantilla_id uuid REFERENCES ruta_plantilla(id),
  punto_fijo_id     uuid REFERENCES punto_fijo(id),
  modalidad         text NOT NULL CHECK (modalidad IN ('coche','moto','a_pie','punto_fijo','oficina')),
  vigencia_desde    date NOT NULL,
  vigencia_hasta    date,
  zona_horaria      text NOT NULL DEFAULT 'America/La_Paz',
  modo              text NOT NULL DEFAULT 'manual' CHECK (modo IN ('manual','automatica')),
  estado            text NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','pausada','archivada')),
  origen            text NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','prueba')),
  version           integer NOT NULL DEFAULT 1,
  creado_por        uuid REFERENCES "user"(id),
  actualizado_por   uuid REFERENCES "user"(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((ruta_plantilla_id IS NULL) <> (punto_fijo_id IS NULL)),
  CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde)
);
CREATE INDEX IF NOT EXISTS ix_ruta_programacion_epi ON ruta_programacion (epi_id) WHERE estado <> 'archivada';

-- 2) Ventanas (horarios) de una programación ----------------------------------
--    dias: 1 = lunes … 7 = domingo (ISO). Una ventana va de su inicio a su
--    fin SIN incluir el fin: el relevo de las 14:00 no se solapa. 24 h se
--    declara con duracion_min = 1440. Una ventana editada o quitada no se
--    borra: queda activo = false, así las ejecuciones ya abiertas conservan
--    su referencia.
CREATE TABLE IF NOT EXISTS ruta_programacion_ventana (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programacion_id uuid NOT NULL REFERENCES ruta_programacion(id),
  dias            smallint[] NOT NULL CHECK (cardinality(dias) BETWEEN 1 AND 7 AND dias <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  hora_inicio     time NOT NULL,
  duracion_min    integer NOT NULL CHECK (duracion_min BETWEEN 15 AND 1440),
  cupo            smallint NOT NULL CHECK (cupo BETWEEN 1 AND 50),
  orden           smallint NOT NULL DEFAULT 0,
  activo          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ruta_programacion_ventana_prog ON ruta_programacion_ventana (programacion_id) WHERE activo;

-- 3) La ejecución recuerda de qué programación y horario salió --------------
--    fecha_local: día LOCAL en que empieza la ventana. Identidad única por
--    ventana y día: un mismo horario no se abre dos veces (ni con dos
--    servidores), y dos ventanas del mismo día son ejecuciones distintas.
--    apertura: cuándo se abrió la tarea (15 min antes, o más tarde si se
--    recuperó tras un reinicio).
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS programacion_id uuid REFERENCES ruta_programacion(id);
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS ventana_id uuid REFERENCES ruta_programacion_ventana(id);
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS fecha_local date;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS programacion_version integer;
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS apertura timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ruta_ejecucion_ventana ON ruta_ejecucion (ventana_id, fecha_local) WHERE ventana_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ruta_ejecucion_programacion ON ruta_ejecucion (programacion_id, inicio) WHERE programacion_id IS NOT NULL;

-- 4) Planificador: interruptor y registro de cada pasada ---------------------
--    habilitado = false deja de ABRIR horarios nuevos; los cierres siguen.
CREATE TABLE IF NOT EXISTS planificador_estado (
  id               smallint PRIMARY KEY CHECK (id = 1),
  habilitado       boolean NOT NULL DEFAULT true,
  ultima_pasada    timestamptz,
  ultima_pasada_ok timestamptz,
  ultimo_error     text,
  cambiado_por     uuid REFERENCES "user"(id),
  cambiado_en      timestamptz,
  motivo           text
);
INSERT INTO planificador_estado (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

--    Una fila por pasada con algo que contar (abiertas, iniciadas, cerradas,
--    perdidas con el servidor caído, omitidas) o con errores.
CREATE TABLE IF NOT EXISTS planificador_registro (
  id        bigserial PRIMARY KEY,
  inicio    timestamptz NOT NULL,
  fin       timestamptz NOT NULL,
  abiertas  integer NOT NULL DEFAULT 0,
  iniciadas integer NOT NULL DEFAULT 0,
  cerradas  integer NOT NULL DEFAULT 0,
  perdidas  integer NOT NULL DEFAULT 0,
  omitidas  integer NOT NULL DEFAULT 0,
  errores   integer NOT NULL DEFAULT 0,
  detalle   jsonb
);
CREATE INDEX IF NOT EXISTS ix_planificador_registro_inicio ON planificador_registro (inicio DESC);

-- 5) Permiso propio: Operador (en su EPI) y Super Admin programan; el Admin
--    solo ve. Filas nuevas; las existentes no se tocan.
INSERT INTO role_permission (role_id, recurso, puede_ver, puede_crear, puede_editar, puede_eliminar)
SELECT r.id, v.recurso, v.ver, v.crear, v.editar, v.eliminar
FROM (VALUES
  ('super_admin',        'programacion_rutas', true, true,  true,  true),
  ('admin',              'programacion_rutas', true, false, false, false),
  ('operador_monitoreo', 'programacion_rutas', true, true,  true,  true)
) AS v(rol, recurso, ver, crear, editar, eliminar)
JOIN role r ON r.codigo = v.rol
ON CONFLICT (role_id, recurso) DO NOTHING;

-- 6) Verificación posterior --------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM role_permission WHERE recurso = 'programacion_rutas') < 3 THEN
    RAISE EXCEPTION '0010: faltan los permisos programacion_rutas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM planificador_estado WHERE id = 1) THEN
    RAISE EXCEPTION '0010: falta la fila del planificador';
  END IF;
END $$;
