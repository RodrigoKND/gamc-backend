import { db } from '@infra/database';
import { poligonosDe, puntoEnTerritorio, type PolygonCoords } from './geometria.js';

// Catálogo EPI dinámico (cambios/04 F1). Única fuente para la Web (lista,
// colores, sedes, mapa) y para el backend (jurisdicción, clasificación de
// puntos). Antes cada capa tenía su propia lista fija de 5 EPIs.
//
// `operativa` = activa Y con territorio vigente: solo esas reciben rutas,
// usuarios y clasificación de hechos nuevos. Las inactivas (Centro Cercado)
// siguen en el catálogo para poder nombrar y colorear registros históricos.

export interface EpiTelefono {
  tipo: string;
  numero: string;
}

export interface EpiCatalogo {
  id: string;
  codigo: string;
  numero: number | null;
  nombre: string;
  nombreOficial: string | null;
  color: string | null;
  activo: boolean;
  operativa: boolean;
  sede: { lat: number; lng: number; direccion: string | null } | null;
  telefonos: EpiTelefono[];
  territorio: {
    version: number;
    aproximado: boolean;
    origen: string;
    poligono: unknown;
  } | null;
}

export interface ModuloPolicialRow {
  id: string;
  codigo: string;
  nombre: string;
  epiId: string;
  epiCodigo: string;
  direccion: string | null;
  zona: string | null;
  lat: number;
  lng: number;
  coordenadasAproximadas: boolean;
  telefono: string | null;
  estado: string | null;
}

// Caché en memoria: el catálogo cambia solo con una migración o una nueva
// versión de territorio. 30 s acota cuánto tarda en verse un cambio hecho
// directo en BD sin reiniciar; `invalidarCatalogoEpis()` lo fuerza.
const TTL_MS = 30_000;
interface CacheCatalogo {
  en: number;
  data: EpiCatalogo[];
  poligonos: Map<string, PolygonCoords[]>;
}
let cache: CacheCatalogo | null = null;
let enCurso: Promise<CacheCatalogo> | null = null;

export function invalidarCatalogoEpis(): void {
  cache = null;
}

function telefonosDe(v: unknown): EpiTelefono[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is { tipo: unknown; numero: unknown } => typeof t === 'object' && t !== null)
    .map((t) => ({ tipo: String(t.tipo ?? ''), numero: String(t.numero ?? '') }))
    .filter((t) => t.numero);
}

async function cargar(): Promise<CacheCatalogo> {
  const rows = await db.epi.findMany({
    include: { territorios: { where: { vigente: true }, take: 1, orderBy: { version: 'desc' } } },
  });
  const data: EpiCatalogo[] = rows.map((e) => {
    const t = e.territorios[0] ?? null;
    return {
      id: e.id,
      codigo: e.codigo,
      numero: e.numero,
      nombre: e.nombre,
      nombreOficial: e.nombreOficial,
      color: e.color,
      activo: e.activo,
      operativa: e.activo && t !== null,
      sede: e.sedeLat != null && e.sedeLng != null ? { lat: e.sedeLat, lng: e.sedeLng, direccion: e.sedeDireccion } : null,
      telefonos: telefonosDe(e.telefonos),
      territorio: t ? { version: t.version, aproximado: t.aproximado, origen: t.origen, poligono: t.poligono } : null,
    };
  });
  // Orden estable: número oficial primero (1..6), luego código — así toda
  // decisión que recorra el catálogo (clasificar un punto en un borde) es
  // reproducible y no depende del orden casual de la consulta.
  data.sort((a, b) => (a.numero ?? 999) - (b.numero ?? 999) || a.codigo.localeCompare(b.codigo));
  const poligonos = new Map(data.map((e) => [e.id, e.territorio ? poligonosDe(e.territorio.poligono) : []]));
  return { en: Date.now(), data, poligonos };
}

async function obtener(): Promise<CacheCatalogo> {
  if (cache && Date.now() - cache.en < TTL_MS) return cache;
  if (!enCurso) {
    enCurso = cargar()
      .then((c) => (cache = c))
      .finally(() => {
        enCurso = null;
      });
  }
  return enCurso;
}

export async function catalogoEpis(): Promise<EpiCatalogo[]> {
  return (await obtener()).data;
}

export async function epiPorId(id: string): Promise<EpiCatalogo | null> {
  return (await catalogoEpis()).find((e) => e.id === id) ?? null;
}

export async function epiPorCodigo(codigo: string): Promise<EpiCatalogo | null> {
  return (await catalogoEpis()).find((e) => e.codigo === codigo) ?? null;
}

export async function poligonosDeEpi(epiId: string): Promise<PolygonCoords[]> {
  return (await obtener()).poligonos.get(epiId) ?? [];
}

export type EstadoClasificacion = 'asignada' | 'fuera_cobertura' | 'ambigua';

export interface Clasificacion {
  estado: EstadoClasificacion;
  epiId: string | null;
  epiCodigo: string | null;
  version: number | null;
}

/**
 * EPI operativa cuyo territorio vigente contiene el punto [lng, lat], sin
 * tolerancia. Fuera de todas → `fuera_cobertura` (nunca "la más cercana":
 * una coordenada errónea no debe caer en una EPI arbitraria). En un
 * solapamiento → `ambigua` con la primera por número oficial, para que el
 * resultado sea reproducible y quede marcado para revisión.
 */
export async function clasificarPunto(p: [number, number]): Promise<Clasificacion> {
  const { data, poligonos } = await obtener();
  const candidatas = data.filter((e) => e.operativa && puntoEnTerritorio(p, poligonos.get(e.id) ?? []));
  if (candidatas.length === 0) return { estado: 'fuera_cobertura', epiId: null, epiCodigo: null, version: null };
  const e = candidatas[0]!;
  return {
    estado: candidatas.length === 1 ? 'asignada' : 'ambigua',
    epiId: e.id,
    epiCodigo: e.codigo,
    version: e.territorio?.version ?? null,
  };
}

export async function modulosPoliciales(): Promise<ModuloPolicialRow[]> {
  const rows = await db.moduloPolicial.findMany({
    where: { activo: true },
    orderBy: { codigo: 'asc' },
    include: { epi: { select: { codigo: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    codigo: m.codigo,
    nombre: m.nombre,
    epiId: m.epiId,
    epiCodigo: m.epi.codigo,
    direccion: m.direccion,
    zona: m.zona,
    lat: m.lat,
    lng: m.lng,
    coordenadasAproximadas: m.coordenadasAproximadas,
    telefono: m.telefono,
    estado: m.estado,
  }));
}
