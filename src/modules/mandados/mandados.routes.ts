import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { alcanceDe } from '@modules/mapas/jurisdiccion';
import { crearMandado, listMandadosDeGuardia, listMandadosRecientes } from './mandados.service.js';

const crearSchema = z.object({
  turnoId: z.string().uuid().optional().nullable(),
  descripcion: z.string().trim().min(3).max(1000),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Mandados — endpoints de la APP (guardia con Bearer) + lectura web para operadores.
// El `guardiaId` sale del JWT en POST/GET / (guardia). GET /todos es para la web.
export function buildMandadosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  // Lectura para la web (operador/admin) — antes no existía, por eso las tareas eran invisibles
  router.get(
    '/todos',
    authorize('hechos', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const desde = typeof req.query.desde === 'string' ? new Date(req.query.desde) : undefined;
      const guardiaId = typeof req.query.guardiaId === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.guardiaId) ? req.query.guardiaId : undefined;
      const mandados = await listMandadosRecientes(await alcanceDe(req.principal!), {
        limit: Number.isFinite(limit) ? limit : 50,
        guardiaId,
        desde: desde && !isNaN(desde.getTime()) ? desde : undefined,
      });
      res.json({ data: mandados });
    }),
  );

  // Endpoints exclusivos de guardia (Bearer)
  router.post(
    '/',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearSchema, req.body);
      const mandado = await crearMandado({ ...input, guardiaId: req.principal!.id });
      res.status(201).json({ data: mandado });
    }),
  );

  router.get(
    '/',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const mandados = await listMandadosDeGuardia(
        req.principal!.id,
        Number.isFinite(limit) ? limit : 100,
      );
      res.json({ data: mandados });
    }),
  );

  return router;
}
