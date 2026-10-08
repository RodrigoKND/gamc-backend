-- Catálogo EPI v2 (cambios/04 §2.4) — GENERADO por scripts/epi/generar_catalogo_v2.py
-- a partir de scripts/epi/inventario_epis.json. No editar a mano: regenerar.
-- Reversión: scripts/sql/revert/0006_epi_catalogo_inventario.revert.sql
--
-- Aditivo salvo las excepciones aprobadas X1 (desactivar centro_cercado) y
-- X2 (nombres oficiales del inventario). Idempotente: se puede volver a
-- aplicar sin duplicar filas.

-- 0) Precondiciones: aborta con mensaje si la BD no es la esperada.
DO $$
BEGIN
  IF to_regclass('public.epi') IS NULL THEN RAISE EXCEPTION '0006: falta la tabla epi'; END IF;
  IF (SELECT count(*) FROM epi WHERE codigo IN ('norte','central','sud','cona_cona')) <> 4 THEN
    RAISE EXCEPTION '0006: faltan EPIs base (norte, central, sud, cona_cona)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='epi' AND column_name='numero' AND data_type <> 'smallint') THEN
    RAISE EXCEPTION '0006: epi.numero ya existe con otro tipo';
  END IF;
END $$;

-- 1) Columnas nuevas de sede/catálogo en epi (nullable).
ALTER TABLE epi ADD COLUMN IF NOT EXISTS numero smallint;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS nombre_oficial text;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_lat double precision;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_lng double precision;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_direccion text;
ALTER TABLE epi ADD COLUMN IF NOT EXISTS telefonos jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS ux_epi_numero ON epi (numero) WHERE numero IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_epi_color') THEN
    ALTER TABLE epi ADD CONSTRAINT ck_epi_color CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- 2) Territorios versionados. epi.poligono queda intacto (versión 1, legado).
CREATE TABLE IF NOT EXISTS epi_territorio (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epi_id      uuid NOT NULL REFERENCES epi(id),
  version     integer NOT NULL,
  poligono    jsonb NOT NULL,
  origen      text NOT NULL,
  aproximado  boolean NOT NULL DEFAULT true,
  vigente     boolean NOT NULL DEFAULT false,
  notas       text,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (epi_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_epi_territorio_vigente ON epi_territorio (epi_id) WHERE vigente;

-- 3) Módulos policiales del inventario (52 MP + FELCV).
CREATE TABLE IF NOT EXISTS modulo_policial (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                  text NOT NULL UNIQUE,
  nombre                  text NOT NULL,
  epi_id                  uuid NOT NULL REFERENCES epi(id),
  direccion               text,
  zona                    text,
  lat                     double precision NOT NULL,
  lng                     double precision NOT NULL,
  coordenadas_aproximadas boolean NOT NULL DEFAULT false,
  telefono                text,
  estado                  text,
  activo                  boolean NOT NULL DEFAULT true,
  fuente                  text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_modulo_policial_epi ON modulo_policial (epi_id);

-- 4) EPIs nuevas del inventario (filas nuevas; ON CONFLICT = idempotente).
INSERT INTO epi (codigo, nombre) VALUES ('jaihuayco', 'EPI Jaihuayco') ON CONFLICT (codigo) DO NOTHING;
INSERT INTO epi (codigo, nombre) VALUES ('alalay_sud', 'EPI Alalay Sud') ON CONFLICT (codigo) DO NOTHING;

-- 5) Datos de sede + X2 (nombres oficiales; el código `sud` se conserva).
UPDATE epi SET numero = 1, nombre = 'EPI Sur', nombre_oficial = 'Estación Policial Integral N° 1 "Sur"', color = '#F5A623', sede_lat = -17.444305, sede_lng = -66.165342, sede_direccion = 'Avenida Panamericana, frente a la Iglesia San Marcos', telefonos = '[{"tipo": "whatsapp", "numero": "57710101"}]'::jsonb, activo = true WHERE codigo = 'sud';
UPDATE epi SET numero = 2, nombre = 'EPI Norte', nombre_oficial = 'Estación Policial Integral N° 2 "Norte"', color = '#5DADE2', sede_lat = -17.361659, sede_lng = -66.172665, sede_direccion = 'Av. Melchor Pérez de Olguín y Calle Franklin D. Roosevelt', telefonos = '[{"tipo": "fijo", "numero": "44444151"}, {"tipo": "fijo", "numero": "44444155"}, {"tipo": "whatsapp", "numero": "67522654"}]'::jsonb, activo = true WHERE codigo = 'norte';
UPDATE epi SET numero = 3, nombre = 'EPI Jaihuayco', nombre_oficial = 'Estación Policial Integral N° 3 "Jaihuayco"', color = '#E57399', sede_lat = -17.4269086, sede_lng = -66.161143, sede_direccion = 'Calle Manuel Virreira y Calle Lizandro e/ C. Daniel Arauco', telefonos = '[{"tipo": "fijo", "numero": "4444177"}]'::jsonb, activo = true WHERE codigo = 'jaihuayco';
UPDATE epi SET numero = 4, nombre = 'EPI Coña Coña', nombre_oficial = 'Estación Policial Integral N° 4 "Coña Coña"', color = '#8E6FCE', sede_lat = -17.389861, sede_lng = -66.203556, sede_direccion = 'C/ José Napoleón Medrano, C. Pedro Nolasco y C. Pedro Arzeta, Zona Coña Coña', telefonos = '[{"tipo": "fijo", "numero": "4444189"}]'::jsonb, activo = true WHERE codigo = 'cona_cona';
UPDATE epi SET numero = 5, nombre = 'EPI Alalay Sud', nombre_oficial = 'Estación Policial Integral N° 5 "Alalay Sud"', color = '#9CCC65', sede_lat = -17.446935, sede_lng = -66.126348, sede_direccion = 'Calle Bélgica entre C. Guinea y Brasilia', telefonos = '[{"tipo": "whatsapp", "numero": "63980022"}]'::jsonb, activo = true WHERE codigo = 'alalay_sud';
UPDATE epi SET numero = 6, nombre = 'EPI Central', nombre_oficial = 'Estación Policial Integral N° 6 "Central"', color = '#26A69A', sede_lat = -17.401111, sede_lng = -66.157417, sede_direccion = 'Calle Ismael Montes y Av. Ayacucho', telefonos = '[{"tipo": "fijo_whatsapp", "numero": "72794299"}]'::jsonb, activo = true WHERE codigo = 'central';
-- Centro Cercado: color histórico para pintar sus registros antiguos.
UPDATE epi SET color = '#0B1B3D' WHERE codigo = 'centro_cercado' AND color IS NULL;

-- 6) X1: Centro Cercado no figura en el inventario oficial → inactiva.
--    Conserva su fila, su UUID y todas sus referencias históricas.
UPDATE epi SET activo = false WHERE codigo = 'centro_cercado';

-- 7) Versión 1 = polígonos legado (0005), solo como historial; no vigentes.
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 1, poligono, 'legado_0005_voronoi_5_epis', true, false, 'Copia de epi.poligono previa al catálogo v2'
FROM epi WHERE poligono IS NOT NULL
ON CONFLICT (epi_id, version) DO NOTHING;

-- 8) Versión 2 = 6 territorios del inventario (Voronoi aproximado), vigentes.
UPDATE epi_territorio SET vigente = false
WHERE vigente AND version <> 2;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.118389,-17.486878],[-66.119038,-17.494462],[-66.150524,-17.497062],[-66.178267,-17.499352],[-66.195592,-17.487348],[-66.214099,-17.474525],[-66.217089,-17.433433],[-66.199177,-17.43213],[-66.196507,-17.429729],[-66.194462,-17.428494],[-66.192799,-17.428473],[-66.167122,-17.434671],[-66.15526,-17.445457],[-66.151921,-17.44545],[-66.142215,-17.457374],[-66.137616,-17.456631],[-66.129621,-17.459898],[-66.125406,-17.469475],[-66.121149,-17.473375],[-66.118389,-17.486878]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'sud'
ON CONFLICT (epi_id, version) DO NOTHING;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.143711,-17.379942],[-66.146338,-17.379422],[-66.152056,-17.380304],[-66.15484,-17.37793],[-66.157413,-17.375153],[-66.164319,-17.366419],[-66.174364,-17.368559],[-66.179268,-17.363901],[-66.180702,-17.360386],[-66.187276,-17.356924],[-66.19413,-17.350396],[-66.186576,-17.340285],[-66.176225,-17.326429],[-66.16083,-17.330723],[-66.151368,-17.333362],[-66.13807,-17.342698],[-66.128666,-17.3493],[-66.124359,-17.352324],[-66.112085,-17.360941],[-66.110136,-17.370785],[-66.104717,-17.398141],[-66.123968,-17.398028],[-66.128147,-17.394693],[-66.138589,-17.383399],[-66.143711,-17.379942]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'norte'
ON CONFLICT (epi_id, version) DO NOTHING;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.15526,-17.445457],[-66.167122,-17.434671],[-66.192799,-17.428473],[-66.194462,-17.428494],[-66.19087,-17.422179],[-66.174985,-17.4074],[-66.164465,-17.404318],[-66.156036,-17.410796],[-66.155368,-17.410254],[-66.152577,-17.40245],[-66.128147,-17.394693],[-66.123968,-17.398028],[-66.13092,-17.407356],[-66.135053,-17.418476],[-66.139436,-17.420974],[-66.146317,-17.434146],[-66.14752,-17.434677],[-66.151921,-17.44545],[-66.15526,-17.445457]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'jaihuayco'
ON CONFLICT (epi_id, version) DO NOTHING;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.194462,-17.428494],[-66.196507,-17.429729],[-66.199177,-17.43213],[-66.217089,-17.433433],[-66.219852,-17.395456],[-66.216787,-17.387229],[-66.215224,-17.383034],[-66.212496,-17.37571],[-66.206197,-17.366888],[-66.200747,-17.359255],[-66.19413,-17.350396],[-66.187276,-17.356924],[-66.180702,-17.360386],[-66.179268,-17.363901],[-66.174364,-17.368559],[-66.176464,-17.375153],[-66.177512,-17.377271],[-66.176778,-17.37793],[-66.171994,-17.385222],[-66.174898,-17.389103],[-66.183378,-17.385428],[-66.185171,-17.394678],[-66.17527,-17.393269],[-66.174,-17.394858],[-66.16241,-17.394364],[-66.164465,-17.404318],[-66.174985,-17.4074],[-66.19087,-17.422179],[-66.194462,-17.428494]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'cona_cona'
ON CONFLICT (epi_id, version) DO NOTHING;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.125406,-17.469475],[-66.129621,-17.459898],[-66.137616,-17.456631],[-66.142215,-17.457374],[-66.151921,-17.44545],[-66.14752,-17.434677],[-66.146317,-17.434146],[-66.139436,-17.420974],[-66.135053,-17.418476],[-66.13092,-17.407356],[-66.123968,-17.398028],[-66.104717,-17.398141],[-66.100263,-17.420631],[-66.095706,-17.443636],[-66.092307,-17.460795],[-66.092279,-17.471563],[-66.092224,-17.492249],[-66.119038,-17.494462],[-66.118389,-17.486878],[-66.121149,-17.473375],[-66.125406,-17.469475]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'alalay_sud'
ON CONFLICT (epi_id, version) DO NOTHING;
INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)
SELECT id, 2, '{"type":"Polygon","coordinates":[[[-66.17527,-17.393269],[-66.185171,-17.394678],[-66.183378,-17.385428],[-66.174898,-17.389103],[-66.171994,-17.385222],[-66.176778,-17.37793],[-66.177512,-17.377271],[-66.176464,-17.375153],[-66.174364,-17.368559],[-66.164319,-17.366419],[-66.157413,-17.375153],[-66.15484,-17.37793],[-66.152056,-17.380304],[-66.146338,-17.379422],[-66.143711,-17.379942],[-66.138589,-17.383399],[-66.128147,-17.394693],[-66.152577,-17.40245],[-66.155368,-17.410254],[-66.156036,-17.410796],[-66.164465,-17.404318],[-66.16241,-17.394364],[-66.174,-17.394858],[-66.17527,-17.393269]]]}'::jsonb, 'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' FROM epi WHERE codigo = 'central'
ON CONFLICT (epi_id, version) DO NOTHING;

-- 9) Módulos policiales.
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-101', '1ro. de Mayo', id, 'Calle Innominada', 'Cercado Sur', -17.46793, -66.202547, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-103', 'Villa Israel', id, 'Entrada Principal', 'Distrito 15', -17.487039, -66.174968, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-104', 'Molle Molle', id, 'Calle Innominada', 'Distrito 9', -17.455392, -66.157324, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-107', 'Pampa San Miguel', id, 'Av. Autonomía', 'Distrito 15', -17.471444, -66.136361, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-109', 'Arrumani Norte', id, 'Calle Innominada', 'Distrito 15', -17.478882, -66.131355, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-201', 'Condebamba', id, 'C. Pirpinto e Iripitan y Sumaj Jatia, Zona Condebamba', NULL, -17.352689, -66.178062, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-202', 'Condebamba (Thomas Mann)', id, 'C. Thomas Mann e/ Torrentera Cantarrana, Condebamba', NULL, -17.362678, -66.15547, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-203', 'Pacata Baja', id, 'Pacata Baja, Av. Circunvalación e/ C. Pariente y M. Daza', NULL, -17.373177, -66.123001, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-204', 'Aranjuez Alto', id, 'C. final Eudoro Galindo y Las Buganvillas, Aranjuez Alto', NULL, -17.360721, -66.142592, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-205', 'Mesadilla', id, 'Av. José Espinoza y C. Josef Guevara, Zona Mesadilla', NULL, -17.367303, -66.129187, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-206', 'Tirani', id, 'Calles Innominadas, Zona Tirani (Colegio Carrillo)', NULL, -17.344367, -66.156577, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-207', 'Condebamba Mz 441', id, 'C. Rucu e/ Calle 10, Condebamba Mz 441', NULL, -17.340196, -66.171531, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-208', 'Barrio Minero 10 de Diciembre', id, 'Barrio Minero 10 de Diciembre, Pacata Alta', NULL, -17.367996, -66.122921, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-210', 'Condebamba Mz 195', id, 'Av. Ecológica e/ Av. Centenario, Condebamba Mz 195', NULL, -17.354057, -66.168041, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'norte' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-301', 'Loreto', id, 'Av. Panamericana y C. J.R. Molina, frente a Parroquia María Auxiliadora', NULL, -17.4212443, -66.1577884, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-302', 'Virgen de Guadalupe', id, 'Calle Virgen de Guadalupe y Calle Tomás de Aquino', NULL, -17.435529, -66.157362, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-303', 'Villa Cosmos', id, 'Av. Sofía Rossel, al lado de la cancha Multifuncional Villa Cosmos', NULL, -17.424872, -66.14873, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-304', 'Guaqui', id, 'Calle C. Guaqui entre calle Colomi y Av. Fuerza Aérea', NULL, -17.411953, -66.16575, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-305', 'Llallipacha', id, 'Calle Rafael Bustillos y Llallipacha', NULL, -17.414137, -66.146841, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-306', 'Colina San Miguel', id, 'OTB Colina San Miguel, Av. Ayllu e Ignacio Chuquimanawi', NULL, -17.404485, -66.147985, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'jaihuayco' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-401', 'OTB San José', id, 'C/Rafael Torrico y Av. Dorvigny', NULL, -17.386333, -66.197917, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-402', 'OTB Quijarro', id, 'Cmons J. de Dios e/ Av. Thadeo Haenke y C/Primo Arrieta', NULL, -17.381389, -66.201806, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-403', 'OTB Villa Bush Norte', id, 'C/Mises Monrroy e/ C/Auza y C/Montero', NULL, -17.390917, -66.194333, false, '4444192', NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-404', 'OTB Villa Bush Sud', id, 'C/Abel Rivas e/ C/Leonardo Da Vinci y C/Benjamín Franklin', NULL, -17.395361, -66.194917, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-405', 'OTB Pampa Grande', id, 'Av. Cap. Ustaris Km 1 1/2 y anterior de la Vía y R. Ronald Rosso', NULL, -17.397194, -66.207694, false, '4444194', NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-406', 'OTB Villa Mercedes', id, 'Calle 23 de Marzo y Calle Adrián Patiño', NULL, -17.388278, -66.188167, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-407', 'OTB Topater', id, 'Calle Chiriguano e/ C/ Arawaqui y 23 de Enero', NULL, -17.373944, -66.189861, false, '4444196', NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-408', 'OTB Rosario', id, 'Av. Daniel Campos y C/ Mons. Ángel Caballero', NULL, -17.397861, -66.178861, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-409', 'OTB Hellein', id, 'Av. Berlios e/ C/ Néstor Olnos y C/ Nicolás Paganini', NULL, -17.366333, -66.191056, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-410', 'OTB Villa Victoria', id, 'Calle Juan e/ Jorge Udaeta y Luis Montaño Milán', NULL, -17.379472, -66.194306, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-411', 'OTB 18 de Mayo', id, 'Av. Melchor Pérez de Olguín Plaza Excombatientes', NULL, -17.384861, -66.177833, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-412', 'OTB Profesional', id, 'C/J.M. Velasco e/ Susana Azogue y C/ Miguel Ángel Valda', NULL, -17.366917, -66.185556, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-413', 'OTB Magisterio Rural Sarco', id, 'C/César Achaval e/ C/ Manuel Paredes y Av. América', NULL, -17.370611, -66.181167, false, '4444202', NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-414', 'OTB Parque Escuela', id, 'Av. Gral. Campero e/ Av. Kilómetro', NULL, -17.398583, -66.169667, false, NULL, NULL, 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'cona_cona' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-501', 'OTB Villa Pagador', id, 'Calle Saucari y Humberto Assin', NULL, -17.438265, -66.115247, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-502', 'Barrio Magisterio', id, 'Avenida Guayacán y Los Ángeles', NULL, -17.422889, -66.123293, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-503', 'OTB Alto Mirador', id, 'Calle Innominada', NULL, -17.430829, -66.137327, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-504', 'OTB Alta Tensión San Miguel', id, 'Calle MOPAS y Arnulfo Romero', NULL, -17.439161, -66.130777, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-505', 'OTB Mula Mayu', id, 'Calle Bolivia e Italia', NULL, -17.441973, -66.128473, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-506', 'OTB San Miguel de Arcángel', id, 'Calle Pedro Toledo', NULL, -17.442177, -66.14109, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-507', 'OTB Alto Mirador (Av. Pisiga)', id, 'Avenida Pisiga', NULL, -17.455644, -66.11234, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-508', 'OTB Nueva Vera Cruz', id, 'Calle San Simón y Calle San Luis', NULL, -17.462728, -66.116554, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-509', 'OTB Lomas de Santa Bárbara', id, 'Calle Innominada', NULL, -17.461988, -66.104304, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-510', 'OTB Minero San Juan', id, 'Calle Innominada', NULL, -17.481201, -66.104253, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-511', 'OTB Uspha Uspha', id, 'Calle Innominada', NULL, -17.474435, -66.109601, false, NULL, 'En mantenimiento / funcionando', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'FELCV-USPHA', 'FELCV Uspha Uspha', id, 'Calle Innominada', NULL, -17.474435, -66.109601, false, NULL, 'Servicio de emergencia / despacho', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'alalay_sud' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-601', 'Parque Carmela Cerruto', id, 'Parque Carmela Cerruto C. Kantutas', NULL, -17.398139, -66.15, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-602', 'Humboldt', id, 'Humboldt y C. Virrey de Francisco Toledo', NULL, -17.390778, -66.17, true, NULL, 'En refacción', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-603', 'Fernando de Soto', id, 'Calle Fernando de Soto y Diego de Almagro', NULL, -17.390722, -66.17, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-604', 'Gabriel René Moreno', id, 'Av. Gabriel René Moreno y Lucas Mendoza', NULL, -17.374167, -66.17, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-605', 'Demetrio Canelas', id, 'Av. Demetrio Canelas y Av. Gabriel René Moreno', NULL, -17.379722, -66.17, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-607', 'Teófilo Vargas', id, 'Av. Teófilo Vargas y C. George Washington', NULL, -17.376139, -66.17, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;
INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) SELECT 'MP-608', 'La Madrid', id, 'Av. La Madrid C. Nueva Castilla', NULL, -17.389861, -66.18, true, NULL, 'En funcionamiento', 'INVENTARIO EPIS COCHABAMBA.docx' FROM epi WHERE codigo = 'central' ON CONFLICT (codigo) DO NOTHING;

-- 10) Verificación posterior: aborta (y revierte la migración) si algo no cuadra.
DO $$
BEGIN
  IF (SELECT count(*) FROM epi_territorio WHERE vigente AND version = 2) <> 6 THEN
    RAISE EXCEPTION '0006: territorios vigentes incompletos';
  END IF;
  IF (SELECT count(*) FROM modulo_policial) < 53 THEN RAISE EXCEPTION '0006: módulos incompletos'; END IF;
  IF (SELECT count(*) FROM epi WHERE activo AND numero IS NOT NULL) <> 6 THEN RAISE EXCEPTION '0006: EPIs activas inesperadas'; END IF;
END $$;
