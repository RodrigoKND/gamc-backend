import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { crearCheckpoint, listCheckpointsDeGuardia } from './checkpoints.service.js';

const crearSchema = z.object({
  turnoId: z.string().uuid().optional().nullable(),
  fotoUrl: z.string().url().max(500),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  capturadoEn: z.coerce.date().optional(),
});

// Checkpoints — endpoints de la APP (guardia con Bearer). El `guardiaId`
// sale del JWT, igual que mandados/turnos.
export function buildCheckpointsRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), requireGuardia);

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearSchema, req.body);
      const checkpoint = await crearCheckpoint({ ...input, guardiaId: req.principal!.id });
      res.status(201).json({ data: checkpoint });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const checkpoints = await listCheckpointsDeGuardia(
        req.principal!.id,
        Number.isFinite(limit) ? limit : 100,
      );
      res.json({ data: checkpoints });
    }),
  );

  return router;
}
