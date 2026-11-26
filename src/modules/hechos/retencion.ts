import { db } from '@infra/database';
import { logger } from '@infra/logger';
import { eliminarArchivo } from '@modules/media/media.storage';

const DIA_MS = 24 * 60 * 60 * 1000;
export const RETENCION_LIMITE = 100;
export const RETENCION_BARRIDO_INTERVALO_MS = 60 * 60 * 1000;

type FiltroHechos = {
  where: unknown;
  take: number;
  select: { id: true; evidencias: true };
};

type HechoRetencion = { id: string; evidencias: Array<{ url: string }> };

type DbRetencion = {
  hecho: {
    findMany(args: FiltroHechos): Promise<HechoRetencion[]>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
};

export type EliminarArchivo = (url: string) => Promise<void>;

export interface OpcionesRetencion {
  db?: DbRetencion;
  eliminarArchivo?: EliminarArchivo;
  ahora?: Date;
  limite?: number;
}

export async function barridoRetencionHechos(opciones: OpcionesRetencion = {}): Promise<{ revisados: number; eliminados: number }> {
  const gestorDb = (opciones.db ?? db) as DbRetencion;
  const borrarArchivo = opciones.eliminarArchivo ?? eliminarArchivo;
  const ahora = opciones.ahora ?? new Date();
  const limite = opciones.limite ?? RETENCION_LIMITE;

  const donde = {
    OR: [
      { nivelRiesgo: 'bajo', reportadoEn: { lt: new Date(ahora.getTime() - DIA_MS) } },
      { nivelRiesgo: 'medio', reportadoEn: { lt: new Date(ahora.getTime() - 15 * DIA_MS) } },
      { nivelRiesgo: { in: ['alto', 'muy_alto'] }, reportadoEn: { lt: new Date(ahora.getTime() - 30 * DIA_MS) } },
    ],
  };

  const hechos = await gestorDb.hecho.findMany({ where: donde, take: limite, select: { id: true, evidencias: true } });
  const ids: string[] = [];

  for (const hecho of hechos) {
    try {
      for (const evidencia of hecho.evidencias) await borrarArchivo(evidencia.url);
      ids.push(hecho.id);
    } catch (error) {
      logger.warn({ err: error, hechoId: hecho.id }, 'Retención: no se pudo borrar la evidencia; el hecho se reintentará.');
    }
  }

  if (ids.length > 0) await gestorDb.hecho.deleteMany({ where: { id: { in: ids } } });
  return { revisados: hechos.length, eliminados: ids.length };
}
