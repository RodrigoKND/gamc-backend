import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppError } from '@shared/errors';
import { Errors } from '@shared/index';
import type { TokenService } from '../application/token.service.js';
import type { AuthService } from '../application/auth.service.js';
import { authenticate, csrfGuard } from './middlewares.js';
import { createAuthController } from './auth.controller.js';

function errBody(err: AppError) {
  return { error: { code: err.code, message: err.message } };
}

// Rutas públicas (devuelven cookies httpOnly). Fuera de estas, el resto del
// API exige `authenticate` + `authorize` (defensa real por rol/recurso).

export function buildAuthRouter(service: AuthService, tokens: TokenService): Router {
  const router = Router();
  const ctrl = createAuthController(service);

  // Contención de fuerza bruta/CSRF en login: ventana corta que se reinicia
  // automáticamente cada 30 segundos y un tope de 5 intentos. Cada 30s el
  // contador vuelve a cero, de modo que un atacante no puede martillar el
  // endpoint sin pausas y el usuario legítimo se desbloquea solo enseguida.
  const loginLimiter = rateLimit({
    windowMs: 30 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true, // los logins correctos no cuentan.
    handler: (_req, res) => res.status(429).json(errBody(Errors.rateLimited())),
  });

  const recoveryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(errBody(Errors.rateLimited())),
  });

  router.post('/login', loginLimiter, ctrl.login);
  router.post('/activar', loginLimiter, ctrl.activar); // guardia · primer login (BD_UNIFICADA §5)
  router.post('/logout', csrfGuard, ctrl.logout);
  router.post('/refresh', ctrl.refresh);
  router.get('/me', authenticate(tokens), ctrl.me);
  router.post('/recovery/request', recoveryLimiter, ctrl.requestRecovery);
  router.post('/recovery/confirm', recoveryLimiter, ctrl.confirmRecovery);
  router.post('/change-password', csrfGuard, authenticate(tokens), ctrl.changePassword);

  return router;
}