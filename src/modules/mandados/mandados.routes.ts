import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
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
      const desde = typeof req.query.desde === 'string' ? req.query.desde : undefined;
      const guardiaId = typeof req.query.guardiaId === 'string' ? req.query.guardiaId : undefined;
      // Si piden filtro por guardia/desde, delegar a servicio específico sería ideal — por ahora lista reciente
      const mandados = await listMandadosRecientes(Number.isFinite(limit) ? limit : 50);
      let filtered = mandados;
      if (guardiaId) filtered = filtered.filter((m) => m.guardiaId === guardiaId);
      if (desde) {
        const desdeDate = new Date(desde);
        if (!isNaN(desdeDate.getTime())) filtered = filtered.filter((m) => new Date(m.creadoEn) >= desdeDate);
      }
      res.json({ data: filtered });
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
