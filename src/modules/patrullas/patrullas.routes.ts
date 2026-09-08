import { Router } from 'express';
import { asyncHandler } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { patrullaVigenteDeGuardia } from './patrullas.service.js';

// Patrullas — endpoint de la APP (guardia con Bearer).
export function buildPatrullasRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), requireGuardia);

  router.get(
    '/vigente',
    asyncHandler(async (req: AuthRequest, res) => {
      const patrulla = await patrullaVigenteDeGuardia(req.principal!.id);
      res.json({ data: patrulla });
    }),
  );

  return router;
}
