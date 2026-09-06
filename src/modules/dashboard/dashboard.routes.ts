import { Router } from 'express';
import { asyncHandler } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize } from '@modules/auth/http/middlewares';
import { hechosPorDia, hechosPorTipo, hechosPorZona, kpis } from './dashboard.service.js';

// Consolida KPIs y series del dashboard. Los listados en crudo viven en sus
// módulos (hechos/guardias): aquí solo agregados.
export function buildDashboardRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), authorize('reportes', 'ver'));

  router.get(
    '/kpi',
    asyncHandler(async (_req, res) => {
      res.json({ data: await kpis() });
    }),
  );

  router.get(
    '/series/deficit',
    asyncHandler(async (req, res) => {
      const dias = Math.min(30, Math.max(1, Number(req.query.dias ?? 7)));
      res.json({ data: await hechosPorDia(dias) });
    }),
  );

  router.get(
    '/series/por-tipo',
    asyncHandler(async (_req, res) => {
      res.json({ data: await hechosPorTipo() });
    }),
  );

  router.get(
    '/series/por-zona',
    asyncHandler(async (_req, res) => {
      res.json({ data: await hechosPorZona() });
    }),
  );

  return router;
}