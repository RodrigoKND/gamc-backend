import { Router } from 'express';
import { asyncHandler } from '@shared/http';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize } from '@modules/auth/http/middlewares';
import { listAudit } from './auditoria.service.js';

export function buildAuditoriaRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/',
    authorize('auditoria', 'ver'),
    asyncHandler(async (req, res) => {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const accion = typeof req.query.accion === 'string' ? req.query.accion : undefined;
      const recurso = typeof req.query.recurso === 'string' ? req.query.recurso : undefined;
      const result = await listAudit({ page, limit, accion, recurso });
      res.json({ data: result });
    }),
  );

  return router;
}