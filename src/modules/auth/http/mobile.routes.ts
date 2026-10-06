import { Router, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError, Errors } from '@shared/errors';
import type { TokenService } from '../application/token.service.js';
import type { AuthService } from '../application/auth.service.js';
import { authenticate, requireGuardia } from './middlewares.js';
import { createAuthController } from './auth.controller.js';

function errBody(err: AppError) {
  return { error: { code: err.code, message: err.message } };
}

/**
 * Convierte `INVALID_CREDENTIALS` de 401 a 400 SOLO en este router.
 *
 * Por qué: la app móvil ya publicada (el APK no se puede recompilar) trata
 * CUALQUIER 401 como "sesión expirada". En su cliente HTTP:
 *
 *   if (res.status === 401 && !_reintento) { refrescar(); throw SesionExpiradaError }
 *
 * El refresh solo tiene sentido si hay una sesión que renovar, y en un login
 * rechazado no hay ninguna: un 401 ahí significa "esa contraseña no es la
 * correcta", no "tu token venció". Como el body se leía DESPUÉS de ese bloque,
 * el mensaje real del backend se perdía y el guardia veía siempre
 * "La sesión expiró. Inicie sesión nuevamente." al escribir mal la clave.
 *
 * Ese mensaje además es un callejón sin salida para el usuario: no depende de
 * nada que él pueda hacer dentro de la app, así que no puede corregir la clave
 * ni saber que el problema era la contraseña. Devolviendo 400 el cliente cae en
 * su rama de error normal y muestra el código real (`INVALID_CREDENTIALS` →
 * "Usuario o contraseña incorrectos").
 *
 * El 401 de verdad (token vencido en `/me` o en `/refresh`) NO se toca: ahí el
 * refresh automático funciona como debe y el mensaje es correcto.
 *
 * `Errors.invalidCredentials` sigue siendo 401 a propósito: la web
 * (`/api/auth/login`) y los tests del servicio dependen de ese status.
 */
const credencialesInvalidasComo400: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err instanceof AppError && err.code === 'INVALID_CREDENTIALS') {
    next(new AppError(400, err.code, err.message, err.issues));
    return;
  }
  next(err);
};

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

  // Va DESPUÉS de las rutas a propósito: Express solo recorre un middleware de
  // error si el `next(err)` ocurre más abajo en la pila.
  router.use(credencialesInvalidasComo400);

  return router;
}
