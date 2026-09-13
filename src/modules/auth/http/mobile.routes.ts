import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppError } from '@shared/errors';
import { Errors } from '@shared/index';
import type { TokenService } from '../application/token.service.js';
import type { AuthService } from '../application/auth.service.js';
import { authenticate, requireGuardia } from './middlewares.js';
import { createAuthController } from './auth.controller.js';

function errBody(err: AppError) {
  return { error: { code: err.code, message: err.message } };
}

// Auth de la app móvil (guardias). Tokens SIEMPRE en el body (nunca cookies).
// Es el espejo de `/api/auth` para el móvil:
//   POST /api/mobile/auth/login    { usuario, password }        → { accessToken, refreshToken, guardia }
//   POST /api/mobile/auth/activar  { usuario, activacion_token, password }
//   POST /api/mobile/auth/refresh  { refreshToken }
//   POST /api/mobile/auth/logout   { refreshToken? }
//   GET  /api/mobile/auth/me       (Bearer)                     → { guardia }
export function buildMobileAuthRouter(service: AuthService, tokens: TokenService): Router {
  const router = Router();
  const ctrl = createAuthController(service);

  const loginLimiter = rateLimit({
    windowMs: 30 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => res.status(429).json(errBody(Errors.rateLimited())),
  });

  router.post('/login', loginLimiter, ctrl.loginMobile);
  router.post('/activar', loginLimiter, ctrl.activar);
  router.post('/refresh', ctrl.refreshMobile);
  router.post('/logout', ctrl.logoutMobile);
  router.get('/me', authenticate(tokens), requireGuardia, ctrl.meMobile);

  return router;
}
