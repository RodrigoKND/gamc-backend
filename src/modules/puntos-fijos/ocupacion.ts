import type { Prisma } from '@prisma/client';
import { db, type Tx } from '@infra/database';
import { Errors } from '@shared/errors';

// Ocupación de puntos fijos (F4). Lo usan el catálogo
// y el motor de asignación, por eso no depende de ninguno de los dos.
//
// Reglas:
//  · La ocupación se cuenta en las HOJAS: el subpunto, o el punto si no tiene
//    subpuntos activos. Un guardia tiene a lo sumo una asignación activa
//    (ux_patrulla_guardia_activa), así que nunca cuenta dos veces.
//  · La capacidad de un punto con subpuntos es la suma de la de sus
//    subpuntos activos (se guarda sincronizada en la raíz).
//  · Toda operación que asigna, retira, mueve o desactiva toma primero la
//    fila de la RAÍZ con FOR UPDATE: dos operadores que compiten por el
//    último cupo (en el punto o en uno de sus subpuntos) quedan en fila.

export const ASIGNACION_ACTIVA = ['asignada', 'en_curso'] as const;
/** Distancia máxima de un subpunto a su punto (partes de un mismo lugar). */
export const DISTANCIA_MAX_SUBPUNTO_M = 1500;

export type FilaPunto = Prisma.PuntoFijoGetPayload<Record<string, never>>;

export interface PuntoBloqueado {
  /** Punto principal (sin padre). */
  raiz: FilaPunto;
  /** El punto pedido (la raíz o uno de sus subpuntos). */
  objetivo: FilaPunto;
  subpuntos: FilaPunto[];
  /** Dónde se cuentan los guardias: subpuntos activos, o la raíz si no tiene. */
  hojas: FilaPunto[];
}

export function hojasDe(raiz: FilaPunto, subpuntos: FilaPunto[]): FilaPunto[] {
  const activos = subpuntos.filter((s) => s.activo);
  return activos.length > 0 ? activos.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)) : [raiz];
}

/** Capacidad del punto completo: suma de subpuntos activos, o la suya. */
export function capacidadEfectiva(raiz: FilaPunto, subpuntos: FilaPunto[]): number {
  return hojasDe(raiz, subpuntos).reduce((s, h) => s + h.capacidad, 0);
}

/** Carga el punto y BLOQUEA su raíz (FOR UPDATE). */
export async function bloquearPunto(tx: Tx, puntoFijoId: string): Promise<PuntoBloqueado> {
  const objetivoPrevio = await tx.puntoFijo.findUnique({ where: { id: puntoFijoId } });
  if (!objetivoPrevio) throw Errors.notFound('El punto fijo no existe.');
  const raizId = objetivoPrevio.padreId ?? objetivoPrevio.id;
  await tx.$queryRaw`SELECT id FROM punto_fijo WHERE id = ${raizId}::uuid FOR UPDATE`;
  // Releer tras el bloqueo: lo que vale es el estado que ya nadie puede cambiar.
  const [raiz, subpuntos, objetivo] = await Promise.all([
    tx.puntoFijo.findUniqueOrThrow({ where: { id: raizId } }),
    tx.puntoFijo.findMany({ where: { padreId: raizId } }),
    tx.puntoFijo.findUniqueOrThrow({ where: { id: puntoFijoId } }),
  ]);
  return { raiz, objetivo, subpuntos, hojas: hojasDe(raiz, subpuntos) };
}

export interface Ocupante {
  patrullaId: string;
  guardiaId: string;
  ejecucionId: string | null;
  puntoFijoId: string;
}

/**
 * Asignaciones activas en estos puntos (hojas). `actuales` deja fuera a los
 * guardias ya asignados a un horario programado que todavía no empezó (F5):
 * el pin del mapa muestra quién está HOY en el punto; el cupo estricto los cuenta.
 */
export async function ocupantesDe(tx: Tx | typeof db, puntoIds: string[], op: { actuales?: boolean } = {}): Promise<Ocupante[]> {
  if (puntoIds.length === 0) return [];
  const rows = await tx.patrulla.findMany({
    where: {
      puntoFijoId: { in: puntoIds },
      estado: { in: [...ASIGNACION_ACTIVA] },
      ...(op.actuales ? { NOT: { estado: 'asignada', ejecucion: { inicio: { gt: new Date() } } } } : {}),
    },
    select: { id: true, guardiaId: true, ejecucionId: true, puntoFijoId: true },
  });
  return rows.map((r) => ({ patrullaId: r.id, guardiaId: r.guardiaId, ejecucionId: r.ejecucionId, puntoFijoId: r.puntoFijoId! }));
}

/** Copia del destino que se guarda en la ejecución (snapshot histórico). */
export function destinoDe(raiz: FilaPunto) {
  return { puntoFijoId: raiz.id, codigo: raiz.codigo, nombre: raiz.nombre, lat: raiz.lat, lng: raiz.lng, version: raiz.version };
}

/** Nombre que ve el guardia: "Cristo Seguro · Plataforma" o "Plaza Colón". */
export function nombreDestino(raiz: FilaPunto, hoja: FilaPunto): string {
  return hoja.id === raiz.id ? raiz.nombre : `${raiz.nombre} · ${hoja.nombre}`;
}

export function distanciaM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
