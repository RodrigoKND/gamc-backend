import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import {
  asignarPatrulla,
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

  router.get(
    '/zonas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await zonasCriticas() });
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
