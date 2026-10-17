-- F4 — Puntos fijos y ocupación.
-- Reversión: scripts/sql/revert/0009_puntos_fijos.revert.sql
--
-- Solo aditivo: tablas nuevas, columnas nuevas nullable, índices nuevos,
-- filas nuevas de catálogo y de permisos. No modifica datos existentes.
-- Idempotente: se puede volver a aplicar sin duplicar nada.

-- 0) Precondiciones ---------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.ruta_ejecucion') IS NULL THEN
    RAISE EXCEPTION '0009: aplicar antes 0007_ruta_ejecucion';
  END IF;
  IF to_regprocedure('fn_gamc_clasificar_punto(double precision, double precision)') IS NULL THEN
    RAISE EXCEPTION '0009: aplicar antes 0008_segmentacion_epi';
  END IF;
END $$;

-- 1) Catálogo de puntos fijos ------------------------------------------------
--    Un punto puede tener subpuntos (un solo nivel: Cristo Seguro →
--    Plataforma / Inicio de gradas). La ocupación se cuenta en las HOJAS
--    (el subpunto, o el punto si no tiene subpuntos); la capacidad de un
--    punto con subpuntos es la suma de la de sus subpuntos activos.
--    epi_metodo: ubicacion = por sus coordenadas; manual = la fijó el
--    Super Admin; padre = subpunto, hereda la EPI de su punto.
CREATE TABLE IF NOT EXISTS punto_fijo (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                  text NOT NULL UNIQUE,
  padre_id                uuid REFERENCES punto_fijo(id),
  nombre                  text NOT NULL,
  descripcion             text,
  epi_id                  uuid NOT NULL REFERENCES epi(id),
  epi_metodo              text NOT NULL DEFAULT 'ubicacion' CHECK (epi_metodo IN ('ubicacion','manual','padre')),
  lat                     double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                     double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  capacidad               smallint NOT NULL CHECK (capacidad BETWEEN 1 AND 50),
  orden                   smallint NOT NULL DEFAULT 0,
  -- true = coordenadas de referencia (OpenStreetMap), pendientes de validar en campo.
  coordenadas_aproximadas boolean NOT NULL DEFAULT true,
  origen                  text NOT NULL DEFAULT 'manual' CHECK (origen IN ('rol_servicio','manual','prueba')),
  activo                  boolean NOT NULL DEFAULT true,
  version                 integer NOT NULL DEFAULT 1,
  creado_por              uuid REFERENCES "user"(id),
  actualizado_por         uuid REFERENCES "user"(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (padre_id IS NULL OR padre_id <> id)
);
CREATE INDEX IF NOT EXISTS ix_punto_fijo_epi ON punto_fijo (epi_id) WHERE activo;
CREATE INDEX IF NOT EXISTS ix_punto_fijo_padre ON punto_fijo (padre_id);

-- 2) Historial: una fila por versión (creación, edición, traslado,
--    desactivación). Conserva qué guardias se vieron afectados y con qué
--    política, para no perder en silencio un destino asignado.
CREATE TABLE IF NOT EXISTS punto_fijo_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  punto_fijo_id uuid NOT NULL REFERENCES punto_fijo(id),
  version       integer NOT NULL,
  cambio        text NOT NULL CHECK (cambio IN ('creado','editado','trasladado','desactivado','reactivado')),
  nombre        text NOT NULL,
  epi_id        uuid REFERENCES epi(id),
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  capacidad     smallint NOT NULL,
  activo        boolean NOT NULL,
  politica      text CHECK (politica IS NULL OR politica IN ('trasladar','retirar')),
  afectados     jsonb,
  motivo        text,
  cambiado_por  uuid REFERENCES "user"(id),
  cambiado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (punto_fijo_id, version)
);

-- 3) Asignación a un punto fijo por su IDENTIDAD, no con un trazado
--    fabricado de dos coordenadas iguales. La ejecución apunta al punto
--    (raíz) y guarda una copia del destino; cada patrulla, a su hoja.
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS punto_fijo_id uuid REFERENCES punto_fijo(id);
ALTER TABLE ruta_ejecucion ADD COLUMN IF NOT EXISTS destino jsonb;
ALTER TABLE patrulla ADD COLUMN IF NOT EXISTS punto_fijo_id uuid REFERENCES punto_fijo(id);
-- Un punto tiene a lo sumo UNA asignación abierta: sus guardias se suman a ella.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ruta_ejecucion_punto_abierta ON ruta_ejecucion (punto_fijo_id)
  WHERE punto_fijo_id IS NOT NULL AND estado IN ('activa','incompleta');
CREATE INDEX IF NOT EXISTS ix_patrulla_punto_fijo_activa ON patrulla (punto_fijo_id)
  WHERE punto_fijo_id IS NOT NULL AND estado IN ('asignada','en_curso');

-- 4) Permiso propio: Operador en su EPI y Super Admin administran; el
--    Admin solo ve. Filas nuevas; las existentes no se tocan.
INSERT INTO role_permission (role_id, recurso, puede_ver, puede_crear, puede_editar, puede_eliminar)
SELECT r.id, v.recurso, v.ver, v.crear, v.editar, v.eliminar
FROM (VALUES
  ('super_admin',        'puntos_fijos', true, true,  true,  true),
  ('admin',              'puntos_fijos', true, false, false, false),
  ('operador_monitoreo', 'puntos_fijos', true, true,  true,  true)
) AS v(rol, recurso, ver, crear, editar, eliminar)
JOIN role r ON r.codigo = v.rol
ON CONFLICT (role_id, recurso) DO NOTHING;

-- 5) Catálogo inicial: puntos del Rol de Servicio (02/09) con capacidad por
--    turno del rol. Coordenadas APROXIMADAS (OpenStreetMap), marcadas como
--    tales: se corrigen desde la web. La EPI sale de la ubicación (misma
--    regla que hechos y guardias); los subpuntos heredan la de su punto.
DO $$
DECLARE p record; c record; padre uuid;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      ('cristo_seguro',      'Cristo Seguro',      'Cristo de la Concordia (cerro San Pedro).',                    -17.384309, -66.134954, 4, 1),
      ('la_coronilla',       'La Coronilla',       'Colina de San Sebastián.',                                    -17.404739, -66.160315, 2, 2),
      ('plaza_principal',    'Plaza Principal',    'Plaza 14 de Septiembre.',                                      -17.393823, -66.156925, 2, 3),
      ('plaza_colon',        'Plaza Colón',        'Plaza Cristóbal Colón.',                                       -17.388206, -66.155728, 2, 4),
      ('pasaje_portales',    'Pasaje Portales',    'Pasaje Portales (zona Palacio Portales).',                     -17.376531, -66.152232, 1, 5),
      ('edificio_municipal', 'Edificio Municipal', 'Gobierno Autónomo Municipal de Cochabamba (calle Lanza).',     -17.387976, -66.154484, 2, 6)
    ) AS t(codigo, nombre, descripcion, lat, lng, capacidad, orden)
  LOOP
    SELECT * INTO c FROM fn_gamc_clasificar_punto(p.lng, p.lat);
    IF c.epi_id IS NULL THEN
      RAISE EXCEPTION '0009: el punto % queda fuera de todas las EPIs', p.codigo;
    END IF;
    INSERT INTO punto_fijo (codigo, nombre, descripcion, epi_id, epi_metodo, lat, lng, capacidad, orden, coordenadas_aproximadas, origen)
    VALUES (p.codigo, p.nombre, p.descripcion, c.epi_id, 'ubicacion', p.lat, p.lng, p.capacidad, p.orden, true, 'rol_servicio')
    ON CONFLICT (codigo) DO NOTHING;
  END LOOP;

  SELECT id INTO padre FROM punto_fijo WHERE codigo = 'cristo_seguro';
  INSERT INTO punto_fijo (codigo, padre_id, nombre, descripcion, epi_id, epi_metodo, lat, lng, capacidad, orden, coordenadas_aproximadas, origen)
  SELECT v.codigo, padre, v.nombre, v.descripcion, pf.epi_id, 'padre', v.lat, v.lng, v.capacidad, v.orden, true, 'rol_servicio'
  FROM (VALUES
    ('cristo_seguro_plataforma', 'Plataforma',       'Plataforma del monumento.',      -17.384309, -66.134954, 2, 1),
    ('cristo_seguro_gradas',     'Inicio de gradas', 'Inicio de las gradas de subida.', -17.387900, -66.139500, 2, 2)
  ) AS v(codigo, nombre, descripcion, lat, lng, capacidad, orden)
  JOIN punto_fijo pf ON pf.id = padre
  ON CONFLICT (codigo) DO NOTHING;

  -- Versión 1 de cada punto del catálogo inicial.
  INSERT INTO punto_fijo_version (punto_fijo_id, version, cambio, nombre, epi_id, lat, lng, capacidad, activo, motivo)
  SELECT id, 1, 'creado', nombre, epi_id, lat, lng, capacidad, activo, 'Catálogo inicial (Rol de Servicio 02/09)'
  FROM punto_fijo WHERE origen = 'rol_servicio'
  ON CONFLICT (punto_fijo_id, version) DO NOTHING;
END $$;

-- 6) Verificación posterior --------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM punto_fijo WHERE origen = 'rol_servicio') < 8 THEN
    RAISE EXCEPTION '0009: falta el catálogo inicial de puntos fijos';
  END IF;
  IF EXISTS (SELECT 1 FROM punto_fijo h JOIN punto_fijo p ON p.id = h.padre_id WHERE p.padre_id IS NOT NULL) THEN
    RAISE EXCEPTION '0009: hay subpuntos con subpuntos (solo se admite un nivel)';
  END IF;
  IF EXISTS (SELECT 1 FROM punto_fijo h JOIN punto_fijo p ON p.id = h.padre_id WHERE h.epi_id <> p.epi_id) THEN
    RAISE EXCEPTION '0009: hay subpuntos con una EPI distinta a la de su punto';
  END IF;
  IF (SELECT count(*) FROM role_permission WHERE recurso = 'puntos_fijos') < 3 THEN
    RAISE EXCEPTION '0009: faltan los permisos puntos_fijos';
  END IF;
END $$;
