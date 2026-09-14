import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { recorridoQuery } from '@modules/turnos/turnos.service';
import {
  asignarPatrulla,
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
// mapas.service.ts:crearRutaPlantilla sobre por qué.
const crearRutaSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(500).optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  trazado: z.array(z.tuple([z.number(), z.number()])).min(2).max(5),
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
