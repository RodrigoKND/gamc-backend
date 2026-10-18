import { Router } from 'express';
import { asyncHandler } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { env } from '@config/env';
import { TtlCache } from '@shared/cache';
import { alcanceDe } from '@modules/mapas/jurisdiccion';
import { hechosPorDia, hechosPorTipo, hechosPorZona, kpis } from './dashboard.service.js';

// Consolida KPIs y series del dashboard. Los listados en crudo viven en sus
// módulos (hechos/guardias): aquí solo agregados.
//
// F3: permiso propio `dashboard` (Admin y Super Admin, como la web). Antes
// colgaba de `reportes:ver`, que también tiene el Operador, y le abría estos
// endpoints por API aunque la web no le muestra el Dashboard.
// Los agregados son idénticos para todos los usuarios con el mismo alcance
// (global o una EPI), así que se cachean por alcance + consulta: N dashboards
// abiertos a la vez cuestan una sola consulta por ventana de TTL.
const cache = new TtlCache<string, unknown>({ ttlMs: env.DASHBOARD_CACHE_SECONDS * 1000, maxEntries: 200 });

async function cached<T>(req: AuthRequest, name: string, load: (alcance: Awaited<ReturnType<typeof alcanceDe>>) => Promise<T>): Promise<T> {
  const alcance = await alcanceDe(req.principal!);
  return cache.getOrLoad(`${name}:${JSON.stringify(alcance)}`, () => load(alcance)) as Promise<T>;
}

export function buildDashboardRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), authorize('dashboard', 'ver'));

  router.get(
    '/kpi',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await cached(req, 'kpi', kpis) });
    }),
  );

  router.get(
    '/series/deficit',
    asyncHandler(async (req: AuthRequest, res) => {
      const dias = Math.min(30, Math.max(1, Number(req.query.dias ?? 7)));
      res.json({ data: await cached(req, `dia:${dias}`, (a) => hechosPorDia(a, dias)) });
    }),
  );

  router.get(
    '/series/por-tipo',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await cached(req, 'tipo', hechosPorTipo) });
    }),
  );

  router.get(
    '/series/por-zona',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await cached(req, 'zona', hechosPorZona) });
    }),
  );

  return router;
}