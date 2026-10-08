import { Router } from 'express';
import { asyncHandler } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate } from '@modules/auth/http/middlewares';
import { catalogoEpis, modulosPoliciales } from './epis.service.js';

// Catálogo EPI (cambios/04 F1). Datos institucionales públicos (nombres,
// sedes, teléfonos, territorios aproximados): basta con estar autenticado,
// igual para la Web que para la app.
export function buildEpisRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ data: await catalogoEpis() });
    }),
  );

  router.get(
    '/modulos',
    asyncHandler(async (_req, res) => {
      res.json({ data: await modulosPoliciales() });
    }),
  );

  return router;
}
