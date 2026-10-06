import json, sys
from shapely.geometry import MultiPoint, Point, box, mapping
from shapely.ops import unary_union
from shapely import voronoi_polygons
def dms(d,m,s): return -(d + m/60 + s/3600)
# (lat, lng) — INVENTARIO EPIS COCHABAMBA.docx (estación + módulos)
U = {
 'sud': [  # EPI 1 Sur + EPI 3 Jaihuayco + EPI 5 Alalay Sud
  (-17.444305,-66.165342),(-17.467930,-66.202547),(-17.487039,-66.174968),(-17.455392,-66.157324),(-17.471444,-66.136361),(-17.478882,-66.131355),
  (-17.4269086,-66.1611430),(-17.4212443,-66.1577884),(-17.435529,-66.157362),(-17.424872,-66.148730),(-17.411953,-66.165750),(-17.414137,-66.146841),(-17.404485,-66.147985),
  (-17.446935,-66.126348),(-17.438265,-66.115247),(-17.422889,-66.123293),(-17.430829,-66.137327),(-17.439161,-66.130777),(-17.441973,-66.128473),(-17.442177,-66.141090),
  (-17.455644,-66.112340),(-17.462728,-66.116554),(-17.461988,-66.104304),(-17.481201,-66.104253),(-17.474435,-66.109601)],
 'norte': [(-17.361659,-66.172665),(-17.352689,-66.178062),(-17.362678,-66.155470),(-17.373177,-66.123001),(-17.360721,-66.142592),(-17.367303,-66.129187),
  (-17.344367,-66.156577),(-17.340196,-66.171531),(-17.367996,-66.122921),(-17.354057,-66.168041)],
 'cona_cona': [(dms(17,23,23.5),dms(66,12,12.8)),(dms(17,23,10.8),dms(66,11,52.5)),(dms(17,22,53.0),dms(66,12,6.5)),(dms(17,23,27.3),dms(66,11,39.6)),
  (dms(17,23,43.3),dms(66,11,41.7)),(dms(17,23,49.9),dms(66,12,27.7)),(dms(17,23,17.8),dms(66,11,17.4)),(dms(17,22,26.2),dms(66,11,23.5)),
  (dms(17,23,52.3),dms(66,10,43.9)),(dms(17,21,58.8),dms(66,11,27.8)),(dms(17,22,46.1),dms(66,11,39.5)),(dms(17,23,5.5),dms(66,10,40.2)),
  (dms(17,22,0.9),dms(66,11,8.0)),(dms(17,22,14.2),dms(66,10,52.2)),(dms(17,23,54.9),dms(66,10,10.8))],
 'central': [(-17.401111,-66.157417),(-17.398139,-66.150000),(-17.390778,-66.170000),(-17.390722,-66.170000),(-17.374167,-66.170000),
  (-17.379722,-66.170000),(-17.376139,-66.170000),(-17.389861,-66.180000)],
}
pts=[]; owner=[]
for k,arr in U.items():
    for lat,lng in arr:
        p=(round(lng,6),round(lat,6))
        if p in pts: continue
        pts.append(p); owner.append(k)
mp = MultiPoint(pts)
area = mp.convex_hull.buffer(0.012, join_style=2)          # ~1.3 km alrededor de las unidades
cells = voronoi_polygons(mp, extend_to=area.envelope.buffer(0.05))
geoms = {k: [] for k in U}
for c in cells.geoms:
    for i,p in enumerate(pts):
        if c.contains(Point(p)) or c.touches(Point(p)):
            geoms[owner[i]].append(c.intersection(area)); break
res = {k: unary_union(v) for k,v in geoms.items()}
casco = box(-66.1610, -17.3990, -66.1500, -17.3840)        # casco viejo: Ayacucho–Oquendo / Aroma–Río Rocha
for k in res: res[k] = res[k].difference(casco)
res['centro_cercado'] = casco
out=[]
for k,g in res.items():
    g = g.simplify(0.00005).buffer(0)
    gj = json.loads(json.dumps(mapping(g)))
    def rnd(o):
        if isinstance(o, (list,tuple)):
            if len(o)==2 and all(isinstance(x,float) for x in o): return [round(o[0],6), round(o[1],6)]
            return [rnd(x) for x in o]
        return o
    gj['coordinates'] = rnd(gj['coordinates'])
    print(k, g.geom_type, round(g.area*12321,2), 'km2', file=sys.stderr)
    out.append(f"UPDATE epi SET poligono = '{json.dumps(gj,separators=(',',':'))}'::jsonb, updated_at = now() WHERE codigo = '{k}';")
print("\n".join(out))
