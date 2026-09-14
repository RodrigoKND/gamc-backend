import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { recorridoQuery } from '@modules/turnos/turnos.service';
import {
  asignarPatrulla,
  cancelarPatrulla,
  cancelarRuta,
  crearRutaPlantilla,
  patrullasVigentes,
  rutasPlantilla,
  ubicacionesActuales,
  zonasCriticas,
} from './mapas.service.js';

const asignarSchema = z.object({
  guardiaId: z.string().uuid(),
  rutaPlantillaId: z.string().uuid().optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  nombre: z.string().trim().max(120).optional().nullable(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  poligonoGeojson: z.unknown().optional().nullable(),
});

// [lng, lat] pelado (no envuelto en GeoJSON) — ver comentario en
// mapas.service.ts:crearRutaPlantilla sobre por qué. El trazado ya viene
// ruteado por calles desde la Web (routing.ts, OSRM) — no son los 2-5
// puntos que clickeó el Operador, es el camino real con muchos vértices
// (rediseño 2026-09-14: "debe ir por las calles").
const crearRutaSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(500).optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  trazado: z.array(z.tuple([z.number(), z.number()])).min(2).max(2000),
  activo: z.boolean().optional(),
});

export function buildMapasRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/ubicaciones',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await ubicacionesActuales() });
    }),
  );

  router.get(
    '/patrullas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await patrullasVigentes() });
    }),
  );

  router.get(
    '/rutas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await rutasPlantilla() });
    }),
  );

  // Rediseño de rutas (RF-G3-09, 2026-09-14, Web): antes no existía forma
  // de crear una `ruta_plantilla` — GET era de solo lectura. Necesario para
  // que el Operador pueda compartir un mismo trazado entre varios guardias
  // (patrulla.rutaPlantillaId). Mismo permiso que asignar una patrulla
  // (`patrullaje:crear`) — es parte del mismo flujo de asignación.
  router.post(
    '/rutas',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearRutaSchema, req.body);
      const ruta = await crearRutaPlantilla({ ...input, creadoPorId: req.principal!.id });
      res.status(201).json({ data: ruta });
    }),
  );

  // Cancela una ruta compartida: TODOS los guardias vigentes en esa
  // rutaPlantillaId quedan 'cancelada' y desaparecen del Mapa de
  // Patrullaje en Vivo (getGuardMarkers en la Web sigue mostrando el pin
  // por telemetría si el guardia sigue en_servicio — lo que desaparece es
  // la línea de ruta y su agrupación en el panel, no el guardia). Mismo
  // permiso que editar una patrulla (`patrullaje:editar`) — el Operador ya
  // lo tiene, cancelar no es "eliminar" (la fila se conserva para auditoría).
  router.patch(
    '/rutas/:id/cancelar',
    authorize('patrullaje', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const resultado = await cancelarRuta(req.params.id!, req.principal!.id);
      res.json({ data: resultado });
    }),
  );

  // Complemento: cancela UN guardia de una ruta compartida sin tocar a los
  // demás (pedido explícito 2026-09-14 — "poder eliminar por guardia por si
  // solo queremos eliminar uno o varios pero no toda la ruta"). Mismo
  // permiso/criterio que cancelar la ruta completa.
  router.patch(
    '/patrullas/:id/cancelar',
    authorize('patrullaje', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const resultado = await cancelarPatrulla(req.params.id!, req.principal!.id);
      res.json({ data: resultado });
    }),
  );

  router.get(
    '/zonas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await zonasCriticas() });
    }),
  );

  // Recorrido real: por turno, o por guardia + ventana temporal.
  router.get(
    '/recorrido',
    authorize('mapas', 'ver'),
    asyncHandler(async (req, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      const data = await recorridoQuery({
        turnoId: str(req.query.turnoId),
        guardiaId: str(req.query.guardiaId),
        desde: str(req.query.desde),
        hasta: str(req.query.hasta),
      });
      res.json({ data });
    }),
  );

  router.post(
    '/patrullas',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(asignarSchema, req.body);
      const patrulla = await asignarPatrulla({
        ...input,
        poligonoGeojson: input.poligonoGeojson as Prisma.InputJsonValue | null | undefined,
        asignadoPorId: req.principal!.id,
      });
      res.status(201).json({ data: patrulla });
    }),
  );

  return router;
}
