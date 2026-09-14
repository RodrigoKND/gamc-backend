-- =============================================================================
-- 01_guardias_simulados.sql — 18 guardias adicionales para pruebas
-- Requiere: haber ejecutado `npm run db:seed` (usuarios + 2 guardias base)
-- Ejecucion: psql -U postgres -d gamc_seguridad -f 01_guardias_simulados.sql
-- Idempotente: ON CONFLICT (ci) DO NOTHING / ON CONFLICT (usuario) DO NOTHING
-- =============================================================================

-- Hash bcrypt cost 12 para 'Guardia#2025' (generado con bcryptjs):
-- $2a$12$0ygOYnFJsLsyTGD5NWGInOmW1zxlQOqKBAWf7/EnC5ZNwFTp2RL8G
-- Si tu politica exige otro password, regenera: node -e "import('bcryptjs').then(m=>m.default.hash('TU_PASS',12).then(console.log))"

DO $$
DECLARE
  v_creado_por uuid := (SELECT id FROM "user" WHERE email = 'maria.rojas@cochabamba.bo');
  v_hash       text := '$2a$12$0ygOYnFJsLsyTGD5NWGInOmW1zxlQOqKBAWf7/EnC5ZNwFTp2RL8G';
BEGIN
  IF v_creado_por IS NULL THEN
    RAISE EXCEPTION 'No existe maria.rojas@cochabamba.bo — ejecuta npm run db:seed primero';
  END IF;

  -- Helper: inserta un guardia si no existe por CI
  -- EPI se resuelve por codigo: norte|central|sud|cona_cona|centro_cercado

  INSERT INTO guardia (epi_id, primer_nombre, segundo_nombre, apellido_paterno, apellido_materno, ci, usuario, password_hash, telefono, fecha_nacimiento, estado, estado_operativo, debe_cambiar_password, creado_por, activado_en)
  VALUES
  ((SELECT id FROM epi WHERE codigo='norte'),         'Juan',     'Carlos',  'Quispe',     'Mamani',   '8000100', 'juan00',     v_hash, '76100000', '1992-03-10', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='central'),       'Luis',     'Fernando','Rojas',      'Vargas',   '8000101', 'luis01',     v_hash, '76100001', '1990-07-12', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='sud'),           'Miguel',   'Angel',   'Torrez',     'Heredia',  '8000102', 'miguel02',   v_hash, '76100002', '1993-11-05', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='cona_cona'),     'Diego',    NULL,      'Flores',     'Condori',  '8000103', 'diego03',    v_hash, '76100003', '1995-01-20', 'activo', 'emergencia',       false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='centro_cercado'),'Roberto',  'Carlos',  'Mendoza',    'Aguilar',  '8000104', 'roberto04',  v_hash, '76100004', '1989-06-18', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='norte'),         'Jorge',    NULL,      'Pereira',    'Soto',     '8000105', 'jorge05',    v_hash, '76100005', '1991-09-25', 'activo', 'fuera_de_servicio',false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='central'),       'Andres',   'Felipe',  'Gutierrez',  'Luna',     '8000106', 'andres06',   v_hash, '76100006', '1994-02-14', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='sud'),           'Marco',    'Antonio', 'Vargas',     'Choque',   '8000107', 'marco07',    v_hash, '76100007', '1996-12-02', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='cona_cona'),     'Pablo',    NULL,      'Silva',      'Reyes',    '8000108', 'pablo08',    v_hash, '76100008', '1990-04-08', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='centro_cercado'),'Eduardo',  'Jose',    'Ortiz',      'Paz',      '8000109', 'eduardo09',  v_hash, '76100009', '1993-08-30', 'activo', 'emergencia',       false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='norte'),         'Victor',   'Hugo',    'Cespedes',   'Zamora',   '8000110', 'victor10',   v_hash, '76100010', '1988-10-11', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='central'),       'Daniel',   NULL,      'Aguirre',    'Cruz',     '8000111', 'daniel11',   v_hash, '76100011', '1992-05-22', 'activo', 'fuera_de_servicio',false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='sud'),           'Oscar',    'Emilio',  'Barrientos', 'Veizaga',  '8000112', 'oscar12',    v_hash, '76100012', '1995-03-15', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='cona_cona'),     'Raul',     NULL,      'Escobar',    'Molina',   '8000113', 'raul13',     v_hash, '76100013', '1991-01-28', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='centro_cercado'),'Cristian', 'David',   'Ledezma',    'Pinto',    '8000114', 'cristian14', v_hash, '76100014', '1994-06-09', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='norte'),         'Marcelo',  NULL,      'Antezana',   'Rivera',   '8000115', 'marcelo15',  v_hash, '76100015', '1990-11-19', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='central'),       'Alex',     NULL,      'Mercado',    'Camacho',  '8000116', 'alex16',     v_hash, '76100016', '1996-02-27', 'activo', 'en_servicio',      false, v_creado_por, now()),
  ((SELECT id FROM epi WHERE codigo='sud'),           'Henry',    NULL,      'Claros',     'Teran',    '8000117', 'henry17',    v_hash, '76100017', '1993-04-03', 'activo', 'en_servicio',      false, v_creado_por, now())
  ON CONFLICT (ci) DO NOTHING;
END $$;

-- Verificacion
SELECT 'guardias_activos' as tabla, count(*) FROM guardia WHERE estado='activo'
UNION ALL
SELECT 'en_servicio', count(*) FROM guardia WHERE estado_operativo='en_servicio'
UNION ALL
SELECT 'emergencia', count(*) FROM guardia WHERE estado_operativo='emergencia'
UNION ALL
SELECT 'fuera_de_servicio', count(*) FROM guardia WHERE estado_operativo='fuera_de_servicio';
