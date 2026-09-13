import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { crearMandado, listMandadosDeGuardia } from './mandados.service.js';

const crearSchema = z.object({
  turnoId: z.string().uuid().optional().nullable(),
  descripcion: z.string().trim().min(3).max(1000),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Mandados — endpoints de la APP (guardia con Bearer). El `guardiaId` sale del JWT.
export function buildMandadosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), requireGuardia);

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearSchema, req.body);
      const mandado = await crearMandado({ ...input, guardiaId: req.principal!.id });
      res.status(201).json({ data: mandado });
    }),
  );

  router.get(
    '/',
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
