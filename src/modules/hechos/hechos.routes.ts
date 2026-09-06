import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { changeHechoEstado, listHechos, listTiposHecho } from './hechos.service.js';

export function buildHechosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/tipos',
    authorize('hechos', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listTiposHecho() });
    }),
  );

  router.get(
    '/',
    authorize('hechos', 'ver'),
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined;
      const estado = typeof req.query.estado === 'string' ? req.query.estado : undefined;
      const epiId = typeof req.query.epiId === 'string' ? req.query.epiId : undefined;
      const desde = typeof req.query.desde === 'string' ? req.query.desde : undefined;
      const hasta = typeof req.query.hasta === 'string' ? req.query.hasta : undefined;
      res.json({ data: await listHechos({ q, tipo, estado, epiId, desde, hasta }) });
    }),
  );

  router.patch(
    '/:id/estado',
    authorize('hechos', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { estado } = validate(z.object({ estado: z.enum(['reportado', 'en_revision', 'cerrado']) }), req.body);
      const hecho = await changeHechoEstado(req.params.id!, estado, req.principal!.id);
      res.json({ data: hecho });
    }),
  );

  return router;
}

