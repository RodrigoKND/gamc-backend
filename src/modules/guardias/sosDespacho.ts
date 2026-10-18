import { db } from '@infra/database';
import { logger } from '@infra/logger';
import { conectadosEn, EVENTS, isRealtimeReady, publishSalas, ROOM_EPI_GLOBAL, salaEpiRol } from '@infra/realtime';
import { catalogoEpis } from '@modules/epis/epis.service';
import { distanciaABordeM, distanciaM, poligonosDe, puntoEnTerritorio, type PolygonCoords } from '@modules/epis/geometria';
import { nombreCompleto } from '@shared/names';
import { ROL_ATIENDE_SOS, ROL_SUPERVISA_SOS, SOS_ESCALAMIENTO_S } from './config.js';

// Despacho de SOS: además del aviso general que ven todos los usuarios web
// (mapa, banner, campana), cada SOS se DIRIGE a quien le corresponde
// atenderlo, para que no quede "a ver quién lo toma":
//
//  1. EPI responsable = la que contiene la posición del guardia. Si cae fuera
//     de toda cobertura, la EPI más cercana (borde del territorio; sin
//     territorio, su sede).
//  2. Lo ATIENDE el Operador de Monitoreo de esa EPI (el rol con `sos:editar`).
//     Si en ese momento no hay ningún operador conectado en esa EPI, pasa al
//     operador de la EPI más cercana que sí tenga.
//  3. SUPERVISAN el Administrador de la EPI responsable y el Super Admin.
//  4. Sin atender en SOS_ESCALAMIENTO_S, ESCALA: operadores de la siguiente
//     EPI más cercana, Administrador de la responsable y Super Admin.
//
// HTTP sigue siendo la fuente de verdad (`sosDespacho` en /mapas/ubicaciones);
// este módulo solo decide a quién empujar el aviso.

export interface EpiSos {
  id: string;
  codigo: string;
  nombre: string;
  sede: { lat: number; lng: number } | null;
  poligonos: PolygonCoords[];
}

export interface EpiOrdenada {
  id: string;
  codigo: string;
  nombre: string;
  /** La posición del SOS está dentro de su territorio. */
  contiene: boolean;
  /** Distancia (m) del SOS a su territorio (0 si lo contiene). */
  distanciaM: number;
  /** Distancia (m) del SOS a la sede de la EPI, si se conoce. */
  distanciaSedeM: number | null;
}

export type MotivoDespacho = 'territorio' | 'epi_mas_cercana' | 'sin_operador_en_epi' | 'sin_operadores_conectados';

export interface Decision {
  responsable: EpiOrdenada | null;
  atiende: EpiOrdenada | null;
  motivo: MotivoDespacho;
}

/** EPIs ordenadas por cercanía al SOS: primero la que lo contiene, luego por distancia. */
export function ordenarEpisParaSos(p: [number, number], epis: EpiSos[]): EpiOrdenada[] {
  return epis
    .map((e) => {
      const contiene = puntoEnTerritorio(p, e.poligonos);
      const distanciaSedeM = e.sede ? Math.round(distanciaM(p, [e.sede.lng, e.sede.lat])) : null;
      const alBorde = e.poligonos.length > 0 ? distanciaABordeM(p, e.poligonos) : Infinity;
      const distancia = contiene ? 0 : Number.isFinite(alBorde) ? alBorde : (distanciaSedeM ?? Infinity);
      return { id: e.id, codigo: e.codigo, nombre: e.nombre, contiene, distanciaM: Math.round(distancia), distanciaSedeM };
    })
    .filter((e) => Number.isFinite(e.distanciaM))
    .sort((a, b) => Number(b.contiene) - Number(a.contiene) || a.distanciaM - b.distanciaM || a.codigo.localeCompare(b.codigo));
}

/** Quién atiende: el operador conectado más cercano, empezando por la EPI responsable. */
export function decidirDespacho(orden: EpiOrdenada[], operadoresConectados: (epiId: string) => number): Decision {
  const responsable = orden[0] ?? null;
  if (!responsable) return { responsable: null, atiende: null, motivo: 'sin_operadores_conectados' };
  const atiende = orden.find((e) => operadoresConectados(e.id) > 0) ?? null;
  if (!atiende) return { responsable, atiende: null, motivo: 'sin_operadores_conectados' };
  if (atiende.id !== responsable.id) return { responsable, atiende, motivo: 'sin_operador_en_epi' };
  return { responsable, atiende, motivo: responsable.contiene ? 'territorio' : 'epi_mas_cercana' };
}

/** Siguiente EPI con operadores conectados después de la que lo tiene asignado. */
export function epiDeEscalamiento(orden: EpiOrdenada[], d: Decision, operadoresConectados: (epiId: string) => number): EpiOrdenada | null {
  const desde = d.atiende ? orden.findIndex((e) => e.id === d.atiende!.id) + 1 : 0;
  return orden.slice(desde).find((e) => e.id !== d.atiende?.id && operadoresConectados(e.id) > 0) ?? null;
}

export type NivelDespacho = 'atender' | 'supervision' | 'escalado';

export interface DespachoPayload {
  alertaId: string;
  guardiaId: string;
  guardiaNombre: string;
  lat: number;
  lng: number;
  capturadoEn: string;
  nivel: NivelDespacho;
  motivo: MotivoDespacho;
  epiResponsable: { id: string; codigo: string; nombre: string } | null;
  epiAtiende: { id: string; codigo: string; nombre: string; distanciaSedeM: number | null } | null;
}

interface Registro {
  guardiaId: string;
  decision: Decision;
  escalado: boolean;
}

// Despachos en curso por alerta (este proceso). Tras un reinicio se
// recalculan: lo peor que pasa es repetir un aviso, nunca perderlo.
const despachos = new Map<string, Registro>();

async function episOperativas(): Promise<EpiSos[]> {
  return (await catalogoEpis())
    .filter((e) => e.operativa)
    .map((e) => ({ id: e.id, codigo: e.codigo, nombre: e.nombre, sede: e.sede, poligonos: poligonosDe(e.territorio?.poligono) }));
}

const operadoresEn = (epiId: string) => conectadosEn(salaEpiRol(epiId, ROL_ATIENDE_SOS));
const ref = (e: EpiOrdenada | null) => (e ? { id: e.id, codigo: e.codigo, nombre: e.nombre } : null);

async function nombreGuardia(guardiaId: string): Promise<string> {
  const g = await db.guardia.findUnique({
    where: { id: guardiaId },
    select: { primerNombre: true, segundoNombre: true, apellidoPaterno: true, apellidoMaterno: true },
  });
  return g ? nombreCompleto(g) : 'Guardia';
}

export interface AlertaSos {
  id: string;
  guardiaId: string;
  lat: number;
  lng: number;
  capturadoEn: Date | string;
}

/** Dirige un SOS nuevo a quien le corresponde. No lanza: un fallo aquí no afecta la ingesta. */
export async function despacharSos(alerta: AlertaSos): Promise<Decision | null> {
  if (!isRealtimeReady()) return null;
  try {
    const orden = ordenarEpisParaSos([alerta.lng, alerta.lat], await episOperativas());
    const decision = decidirDespacho(orden, operadoresEn);
    despachos.set(alerta.id, { guardiaId: alerta.guardiaId, decision, escalado: false });

    const base = {
      alertaId: alerta.id,
      guardiaId: alerta.guardiaId,
      guardiaNombre: await nombreGuardia(alerta.guardiaId),
      lat: alerta.lat,
      lng: alerta.lng,
      capturadoEn: new Date(alerta.capturadoEn).toISOString(),
      motivo: decision.motivo,
      epiResponsable: ref(decision.responsable),
      epiAtiende: decision.atiende ? { ...ref(decision.atiende)!, distanciaSedeM: decision.atiende.distanciaSedeM } : null,
    };
    const enviar = (nivel: NivelDespacho, salas: string[]) =>
      publishSalas(EVENTS.sosDespacho, salas, { ...base, nivel } satisfies DespachoPayload);

    const supervisores = new Set<string>([ROOM_EPI_GLOBAL]);
    if (decision.responsable) supervisores.add(salaEpiRol(decision.responsable.id, ROL_SUPERVISA_SOS));

    if (decision.atiende) {
      enviar('atender', [salaEpiRol(decision.atiende.id, ROL_ATIENDE_SOS)]);
    } else if (decision.responsable) {
      // Ningún operador conectado en toda la ciudad: el Administrador de la EPI lo toma.
      const admin = salaEpiRol(decision.responsable.id, ROL_SUPERVISA_SOS);
      enviar('atender', [admin]);
      supervisores.delete(admin);
    }
    enviar('supervision', [...supervisores]);

    logger.info(
      { alertaId: alerta.id, guardiaId: alerta.guardiaId, responsable: decision.responsable?.codigo, atiende: decision.atiende?.codigo, motivo: decision.motivo },
      'SOS despachado',
    );
    return decision;
  } catch (err) {
    logger.error({ err, alertaId: alerta.id }, 'No se pudo despachar el SOS (el aviso general sí se envió)');
    return null;
  }
}

/** Escala los SOS que siguen pendientes pasado el plazo; limpia los ya atendidos. */
export async function barridoEscalamientoSos(ahora = new Date()): Promise<number> {
  if (!isRealtimeReady()) return 0;
  const pendientes = await db.guardiaTelemetria.findMany({
    where: { esSos: true, OR: [{ sosEstado: null }, { sosEstado: 'pendiente' }] },
    select: { id: true, guardiaId: true, lat: true, lng: true, capturadoEn: true },
    orderBy: { capturadoEn: 'desc' },
    take: 200,
  });
  const abiertas = new Set(pendientes.map((p) => p.id.toString()));
  for (const id of despachos.keys()) if (!abiertas.has(id)) despachos.delete(id);

  const limite = ahora.getTime() - SOS_ESCALAMIENTO_S * 1000;
  const vencidas = pendientes.filter((p) => p.capturadoEn.getTime() <= limite && !despachos.get(p.id.toString())?.escalado);
  if (vencidas.length === 0) return 0;

  const epis = await episOperativas();
  for (const p of vencidas) {
    const id = p.id.toString();
    const orden = ordenarEpisParaSos([p.lng, p.lat], epis);
    const decision = despachos.get(id)?.decision ?? decidirDespacho(orden, operadoresEn);
    const vecina = epiDeEscalamiento(orden, decision, operadoresEn);
    despachos.set(id, { guardiaId: p.guardiaId, decision, escalado: true });

    const salas = [ROOM_EPI_GLOBAL];
    if (decision.responsable) salas.push(salaEpiRol(decision.responsable.id, ROL_SUPERVISA_SOS));
    if (vecina) salas.push(salaEpiRol(vecina.id, ROL_ATIENDE_SOS));
    publishSalas(EVENTS.sosDespacho, salas, {
      alertaId: id,
      guardiaId: p.guardiaId,
      guardiaNombre: await nombreGuardia(p.guardiaId),
      lat: p.lat,
      lng: p.lng,
      capturadoEn: p.capturadoEn.toISOString(),
      nivel: 'escalado',
      motivo: decision.motivo,
      epiResponsable: ref(decision.responsable),
      epiAtiende: vecina ? { ...ref(vecina)!, distanciaSedeM: vecina.distanciaSedeM } : null,
    } satisfies DespachoPayload);
    logger.warn({ alertaId: id, guardiaId: p.guardiaId, responsable: decision.responsable?.codigo, vecina: vecina?.codigo }, 'SOS sin atender: escalado');
  }
  return vencidas.length;
}

export interface EstadoDespacho {
  epiResponsableCodigo: string | null;
  epiResponsableNombre: string | null;
  epiAtiendeCodigo: string | null;
  escalado: boolean;
}

/**
 * Estado del despacho de un guardia con SOS abierto, para la API (fuente de
 * verdad del cliente). Sin registro en memoria (reinicio), se recalcula.
 */
export async function estadoDespacho(
  sos: { guardiaId: string; alertaIds: string[]; desde: Date; lat: number; lng: number },
  ahora = new Date(),
): Promise<EstadoDespacho> {
  const reg = sos.alertaIds.map((id) => despachos.get(id)).find(Boolean);
  const decision = reg?.decision ?? decidirDespacho(ordenarEpisParaSos([sos.lng, sos.lat], await episOperativas()), isRealtimeReady() ? operadoresEn : () => 1);
  return {
    epiResponsableCodigo: decision.responsable?.codigo ?? null,
    epiResponsableNombre: decision.responsable?.nombre ?? null,
    epiAtiendeCodigo: decision.atiende?.codigo ?? null,
    escalado: Boolean(reg?.escalado) || ahora.getTime() - sos.desde.getTime() >= SOS_ESCALAMIENTO_S * 1000,
  };
}

/** Solo para pruebas. */
export function _reiniciarDespachos(): void {
  despachos.clear();
}
