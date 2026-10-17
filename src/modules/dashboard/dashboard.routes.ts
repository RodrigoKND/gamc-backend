import { Router } from 'express';
import { asyncHandler } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { alcanceDe } from '@modules/mapas/jurisdiccion';
import { hechosPorDia, hechosPorTipo, hechosPorZona, kpis } from './dashboard.service.js';

// Consolida KPIs y series del dashboard. Los listados en crudo viven en sus
// módulos (hechos/guardias): aquí solo agregados.
//
// F3: permiso propio `dashboard` (Admin y Super Admin, como la web). Antes
// colgaba de `reportes:ver`, que también tiene el Operador, y le abría estos
// endpoints por API aunque la web no le muestra el Dashboard.
export function buildDashboardRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), authorize('dashboard', 'ver'));

  router.get(
    '/kpi',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await kpis(await alcanceDe(req.principal!)) });
    }),
  );

  router.get(
    '/series/deficit',
    asyncHandler(async (req: AuthRequest, res) => {
      const dias = Math.min(30, Math.max(1, Number(req.query.dias ?? 7)));
      res.json({ data: await hechosPorDia(await alcanceDe(req.principal!), dias) });
    }),
  );

  router.get(
    '/series/por-tipo',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await hechosPorTipo(await alcanceDe(req.principal!)) });
    }),
  );

  router.get(
    '/series/por-zona',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await hechosPorZona(await alcanceDe(req.principal!)) });
    }),
  );

  return router;
}