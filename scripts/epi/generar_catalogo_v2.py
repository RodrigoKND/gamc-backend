"""Catálogo EPI v2 (6 EPIs del inventario oficial) → migración 0006.

Uso (desde la raíz del backend, requiere `pip install shapely`):
    python scripts/epi/generar_catalogo_v2.py

Lee scripts/epi/inventario_epis.json y escribe:
  · prisma/migrations/0006_epi_catalogo_inventario/migration.sql
  · scripts/sql/revert/0006_epi_catalogo_inventario.revert.sql
e imprime un informe de validación (stderr). Falla si un territorio es
inválido, si dos se solapan o si una sede/módulo queda fuera de su EPI.

Los territorios son APROXIMADOS: celdas de Voronoi de sedes + módulos,
recortadas a la envolvente de todas las unidades con un margen de ~1.3 km.
No son límites oficiales (ver cambios/04 §2.4). Sustituye a
generar_poligonos.py (5 EPIs, con el casco viejo inventado como
`centro_cercado`), que se conserva solo como referencia de la versión 1.
"""
import json
import re
import sys
from pathlib import Path

from shapely.geometry import MultiPoint, Point, mapping
from shapely.ops import unary_union
from shapely import voronoi_polygons

RAIZ = Path(__file__).resolve().parents[2]
INVENTARIO = RAIZ / 'scripts/epi/inventario_epis.json'
MIGRACION = RAIZ / 'prisma/migrations/0006_epi_catalogo_inventario/migration.sql'
REVERT = RAIZ / 'scripts/sql/revert/0006_epi_catalogo_inventario.revert.sql'
VERSION = 2
KM2 = 12321  # grado² → km² aprox. a esta latitud (111 km × 111 km)


def dms_a_decimal(texto):
    """'17°23'23.5"S 66°12'12.8"W' → (lat, lng)."""
    partes = re.findall(r"(\d+)°(\d+)'([\d.]+)\"([NSEW])", texto)
    if len(partes) != 2:
        raise ValueError(f'DMS inválido: {texto}')
    out = []
    for g, m, s, h in partes:
        v = int(g) + int(m) / 60 + float(s) / 3600
        out.append(-v if h in 'SW' else v)
    return round(out[0], 6), round(out[1], 6)


def coords(item):
    if 'dms' in item:
        return dms_a_decimal(item['dms'])
    return round(item['lat'], 7), round(item['lng'], 7)


def sql_txt(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"


def redondear(o):
    if isinstance(o, (list, tuple)):
        if len(o) == 2 and all(isinstance(x, float) for x in o):
            return [round(o[0], 6), round(o[1], 6)]
        return [redondear(x) for x in o]
    return o


def main():
    inv = json.loads(INVENTARIO.read_text(encoding='utf-8'))
    epis = inv['epis']

    # Puntos de cálculo (sede + módulos). Se deduplican solo para Voronoi:
    # MP-511 y FELCV comparten coordenadas pero siguen siendo dos módulos.
    pts, dueno = [], []
    for e in epis:
        unidades = [e['sede']] + e['modulos']
        for u in unidades:
            lat, lng = coords(u)
            p = (round(lng, 6), round(lat, 6))
            if p in pts:
                continue
            pts.append(p)
            dueno.append(e['codigo'])

    mp = MultiPoint(pts)
    area = mp.convex_hull.buffer(0.012, join_style=2)
    celdas = voronoi_polygons(mp, extend_to=area.envelope.buffer(0.05))
    por_epi = {e['codigo']: [] for e in epis}
    for c in celdas.geoms:
        for i, p in enumerate(pts):
            if c.contains(Point(p)) or c.touches(Point(p)):
                por_epi[dueno[i]].append(c.intersection(area))
                break
    territorios = {k: unary_union(v) for k, v in por_epi.items()}

    # ── Validación ────────────────────────────────────────────────────────
    errores = []
    informe = []
    for k, g in territorios.items():
        if not g.is_valid:
            errores.append(f'{k}: geometría inválida')
        huecos = sum(len(p.interiors) for p in getattr(g, 'geoms', [g]))
        informe.append(f'{k:11s} {g.geom_type:12s} {g.area * KM2:7.2f} km²  huecos={huecos}')
    claves = list(territorios)
    for i, a in enumerate(claves):
        for b in claves[i + 1:]:
            sol = territorios[a].intersection(territorios[b]).area * KM2
            if sol > 1e-6:
                errores.append(f'solapamiento {a}/{b}: {sol:.6f} km²')
    union = unary_union(list(territorios.values()))
    hueco_cobertura = area.difference(union).area * KM2
    informe.append(f'cobertura: unión={union.area * KM2:.2f} km², área={area.area * KM2:.2f} km², sin cubrir={hueco_cobertura:.6f} km²')
    for e in epis:
        g = territorios[e['codigo']]
        for u in [e['sede']] + e['modulos']:
            lat, lng = coords(u)
            if not g.buffer(1e-9).contains(Point(lng, lat)):
                errores.append(f"{e['codigo']}: {u.get('codigo', 'sede')} fuera de su territorio")
    print('\n'.join(informe), file=sys.stderr)
    if errores:
        print('ERRORES:\n  ' + '\n  '.join(errores), file=sys.stderr)
        sys.exit(1)
    print('Validación OK', file=sys.stderr)

    # ── SQL ───────────────────────────────────────────────────────────────
    L = []
    w = L.append
    w('-- Catálogo EPI v2 (cambios/04 §2.4) — GENERADO por scripts/epi/generar_catalogo_v2.py')
    w('-- a partir de scripts/epi/inventario_epis.json. No editar a mano: regenerar.')
    w('-- Reversión: scripts/sql/revert/0006_epi_catalogo_inventario.revert.sql')
    w('--')
    w('-- Aditivo salvo las excepciones aprobadas X1 (desactivar centro_cercado) y')
    w('-- X2 (nombres oficiales del inventario). Idempotente: se puede volver a')
    w('-- aplicar sin duplicar filas.')
    w('')
    w('-- 0) Precondiciones: aborta con mensaje si la BD no es la esperada.')
    w('DO $$')
    w('BEGIN')
    w("  IF to_regclass('public.epi') IS NULL THEN RAISE EXCEPTION '0006: falta la tabla epi'; END IF;")
    w("  IF (SELECT count(*) FROM epi WHERE codigo IN ('norte','central','sud','cona_cona')) <> 4 THEN")
    w("    RAISE EXCEPTION '0006: faltan EPIs base (norte, central, sud, cona_cona)';")
    w('  END IF;')
    w("  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='epi' AND column_name='numero' AND data_type <> 'smallint') THEN")
    w("    RAISE EXCEPTION '0006: epi.numero ya existe con otro tipo';")
    w('  END IF;')
    w('END $$;')
    w('')
    w('-- 1) Columnas nuevas de sede/catálogo en epi (nullable).')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS numero smallint;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS nombre_oficial text;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS color text;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_lat double precision;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_lng double precision;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS sede_direccion text;')
    w('ALTER TABLE epi ADD COLUMN IF NOT EXISTS telefonos jsonb;')
    w('CREATE UNIQUE INDEX IF NOT EXISTS ux_epi_numero ON epi (numero) WHERE numero IS NOT NULL;')
    w('DO $$ BEGIN')
    w("  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_epi_color') THEN")
    w("    ALTER TABLE epi ADD CONSTRAINT ck_epi_color CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');")
    w('  END IF;')
    w('END $$;')
    w('')
    w('-- 2) Territorios versionados. epi.poligono queda intacto (versión 1, legado).')
    w('CREATE TABLE IF NOT EXISTS epi_territorio (')
    w('  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),')
    w('  epi_id      uuid NOT NULL REFERENCES epi(id),')
    w('  version     integer NOT NULL,')
    w('  poligono    jsonb NOT NULL,')
    w('  origen      text NOT NULL,')
    w('  aproximado  boolean NOT NULL DEFAULT true,')
    w('  vigente     boolean NOT NULL DEFAULT false,')
    w('  notas       text,')
    w('  creado_en   timestamptz NOT NULL DEFAULT now(),')
    w('  UNIQUE (epi_id, version)')
    w(');')
    w('CREATE UNIQUE INDEX IF NOT EXISTS ux_epi_territorio_vigente ON epi_territorio (epi_id) WHERE vigente;')
    w('')
    w('-- 3) Módulos policiales del inventario (52 MP + FELCV).')
    w('CREATE TABLE IF NOT EXISTS modulo_policial (')
    w('  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),')
    w('  codigo                  text NOT NULL UNIQUE,')
    w('  nombre                  text NOT NULL,')
    w('  epi_id                  uuid NOT NULL REFERENCES epi(id),')
    w('  direccion               text,')
    w('  zona                    text,')
    w('  lat                     double precision NOT NULL,')
    w('  lng                     double precision NOT NULL,')
    w('  coordenadas_aproximadas boolean NOT NULL DEFAULT false,')
    w('  telefono                text,')
    w('  estado                  text,')
    w('  activo                  boolean NOT NULL DEFAULT true,')
    w('  fuente                  text NOT NULL,')
    w('  created_at              timestamptz NOT NULL DEFAULT now()')
    w(');')
    w('CREATE INDEX IF NOT EXISTS ix_modulo_policial_epi ON modulo_policial (epi_id);')
    w('')
    w('-- 4) EPIs nuevas del inventario (filas nuevas; ON CONFLICT = idempotente).')
    nuevas = [e for e in epis if e['codigo'] not in ('norte', 'central', 'sud', 'cona_cona')]
    for e in nuevas:
        w(f"INSERT INTO epi (codigo, nombre) VALUES ({sql_txt(e['codigo'])}, {sql_txt(e['nombre'])}) ON CONFLICT (codigo) DO NOTHING;")
    w('')
    w('-- 5) Datos de sede + X2 (nombres oficiales; el código `sud` se conserva).')
    for e in epis:
        lat, lng = coords(e['sede'])
        w(
            'UPDATE epi SET '
            f"numero = {e['numero']}, nombre = {sql_txt(e['nombre'])}, nombre_oficial = {sql_txt(e['nombreOficial'])}, "
            f"color = {sql_txt(e['color'])}, sede_lat = {lat}, sede_lng = {lng}, "
            f"sede_direccion = {sql_txt(e['sede']['direccion'])}, "
            f"telefonos = {sql_txt(json.dumps(e['telefonos'], ensure_ascii=False))}::jsonb, activo = true "
            f"WHERE codigo = {sql_txt(e['codigo'])};"
        )
    w('-- Centro Cercado: color histórico para pintar sus registros antiguos.')
    w("UPDATE epi SET color = '#0B1B3D' WHERE codigo = 'centro_cercado' AND color IS NULL;")
    w('')
    w('-- 6) X1: Centro Cercado no figura en el inventario oficial → inactiva.')
    w('--    Conserva su fila, su UUID y todas sus referencias históricas.')
    w("UPDATE epi SET activo = false WHERE codigo = 'centro_cercado';")
    w('')
    w('-- 7) Versión 1 = polígonos legado (0005), solo como historial; no vigentes.')
    w("INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)")
    w("SELECT id, 1, poligono, 'legado_0005_voronoi_5_epis', true, false, 'Copia de epi.poligono previa al catálogo v2'")
    w('FROM epi WHERE poligono IS NOT NULL')
    w('ON CONFLICT (epi_id, version) DO NOTHING;')
    w('')
    w(f'-- 8) Versión {VERSION} = 6 territorios del inventario (Voronoi aproximado), vigentes.')
    w('UPDATE epi_territorio SET vigente = false')
    w(f'WHERE vigente AND version <> {VERSION};')
    for e in epis:
        gj = mapping(territorios[e['codigo']])
        gj = {'type': gj['type'], 'coordinates': redondear(json.loads(json.dumps(gj['coordinates'])))}
        w("INSERT INTO epi_territorio (epi_id, version, poligono, origen, aproximado, vigente, notas)")
        w(
            f"SELECT id, {VERSION}, {sql_txt(json.dumps(gj, separators=(',', ':')))}::jsonb, "
            f"'voronoi_inventario_2026', true, true, 'Aproximado: celdas de Voronoi de sede + módulos. No es límite oficial.' "
            f"FROM epi WHERE codigo = {sql_txt(e['codigo'])}"
        )
        w('ON CONFLICT (epi_id, version) DO NOTHING;')
    w('')
    w('-- 9) Módulos policiales.')
    fuente = 'INVENTARIO EPIS COCHABAMBA.docx'
    for e in epis:
        for m in e['modulos']:
            lat, lng = coords(m)
            w(
                'INSERT INTO modulo_policial (codigo, nombre, epi_id, direccion, zona, lat, lng, coordenadas_aproximadas, telefono, estado, fuente) '
                f"SELECT {sql_txt(m['codigo'])}, {sql_txt(m['nombre'])}, id, {sql_txt(m.get('direccion'))}, {sql_txt(m.get('zona'))}, "
                f"{lat}, {lng}, {'true' if m.get('aproximada') else 'false'}, {sql_txt(m.get('telefono'))}, {sql_txt(m.get('estado'))}, {sql_txt(fuente)} "
                f"FROM epi WHERE codigo = {sql_txt(e['codigo'])} ON CONFLICT (codigo) DO NOTHING;"
            )
    w('')
    w('-- 10) Verificación posterior: aborta (y revierte la migración) si algo no cuadra.')
    w('DO $$')
    w('BEGIN')
    w(f"  IF (SELECT count(*) FROM epi_territorio WHERE vigente AND version = {VERSION}) <> {len(epis)} THEN")
    w("    RAISE EXCEPTION '0006: territorios vigentes incompletos';")
    w('  END IF;')
    total_mod = sum(len(e['modulos']) for e in epis)
    w(f"  IF (SELECT count(*) FROM modulo_policial) < {total_mod} THEN RAISE EXCEPTION '0006: módulos incompletos'; END IF;")
    w(f"  IF (SELECT count(*) FROM epi WHERE activo AND numero IS NOT NULL) <> {len(epis)} THEN RAISE EXCEPTION '0006: EPIs activas inesperadas'; END IF;")
    w('END $$;')
    MIGRACION.parent.mkdir(parents=True, exist_ok=True)
    MIGRACION.write_text('\n'.join(L) + '\n', encoding='utf-8')

    R = [
        '-- Reversión de 0006_epi_catalogo_inventario (cambios/04 §2.4).',
        '-- Restaura nombres y estado de las EPIs base, y elimina lo agregado.',
        '-- Las EPIs nuevas solo se borran si nada las referencia; si hay datos',
        '-- que ya las usan, la reversión se detiene para no perder información.',
        'BEGIN;',
        'DO $$',
        'DECLARE n integer;',
        'BEGIN',
        "  SELECT (SELECT count(*) FROM guardia g JOIN epi e ON e.id = g.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        "       + (SELECT count(*) FROM \"user\" u JOIN epi e ON e.id = u.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        "       + (SELECT count(*) FROM hecho h JOIN epi e ON e.id = h.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        "       + (SELECT count(*) FROM patrulla p JOIN epi e ON e.id = p.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        "       + (SELECT count(*) FROM ruta_plantilla r JOIN epi e ON e.id = r.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        "       + (SELECT count(*) FROM zona_critica_activa z JOIN epi e ON e.id = z.epi_id WHERE e.codigo IN ('jaihuayco','alalay_sud'))",
        '    INTO n;',
        "  IF n > 0 THEN RAISE EXCEPTION 'Reversión 0006 detenida: % registros usan Jaihuayco/Alalay Sud', n; END IF;",
        'END $$;',
        'DROP TABLE IF EXISTS modulo_policial;',
        'DROP TABLE IF EXISTS epi_territorio;',
        "DELETE FROM epi WHERE codigo IN ('jaihuayco','alalay_sud');",
        "UPDATE epi SET nombre = 'EPI Norte' WHERE codigo = 'norte';",
        "UPDATE epi SET nombre = 'EPI Central' WHERE codigo = 'central';",
        "UPDATE epi SET nombre = 'EPI Sud' WHERE codigo = 'sud';",
        "UPDATE epi SET nombre = 'EPI Coña Coña' WHERE codigo = 'cona_cona';",
        "UPDATE epi SET activo = true WHERE codigo = 'centro_cercado';",
        'ALTER TABLE epi DROP CONSTRAINT IF EXISTS ck_epi_color;',
        'DROP INDEX IF EXISTS ux_epi_numero;',
        'ALTER TABLE epi DROP COLUMN IF EXISTS numero, DROP COLUMN IF EXISTS nombre_oficial, DROP COLUMN IF EXISTS color,',
        '  DROP COLUMN IF EXISTS sede_lat, DROP COLUMN IF EXISTS sede_lng, DROP COLUMN IF EXISTS sede_direccion, DROP COLUMN IF EXISTS telefonos;',
        "DO $$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN",
        "  DELETE FROM _prisma_migrations WHERE migration_name = '0006_epi_catalogo_inventario'; END IF; END $$;",
        'COMMIT;',
    ]
    REVERT.parent.mkdir(parents=True, exist_ok=True)
    REVERT.write_text('\n'.join(R) + '\n', encoding='utf-8')
    print(f'Escrito {MIGRACION.relative_to(RAIZ)} y {REVERT.relative_to(RAIZ)}', file=sys.stderr)


if __name__ == '__main__':
    main()
