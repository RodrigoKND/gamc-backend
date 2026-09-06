import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { COOKIES } from '@shared/cookies';
import { constantTimeEqual } from '@shared/security';
import { can, Errors, type PolicyAction } from '@shared/index';
import type { AccessTokenClaims } from '@modules/auth/application/auth.types';
import type { TokenService } from '../application/token.service.js';

// Middlewares HTTP del módulo auth. Deciden QUÉ identifica a un request
// (authenticate), QUÉ puede hacer (authorize) y que no es un ataque CSRF
// (csrfGuard). La defensa real es el backend; el frontend solo oculta UI.

import type { AuthenticatedPrincipal, UserRole } from '@modules/auth/application/auth.types';

export interface AuthRequest extends Request {
  principal?: AuthenticatedPrincipal;
  claims?: AccessTokenClaims;
}

export function authenticate(tokens: TokenService): RequestHandler {
  return async (req: AuthRequest, _res, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIES.access];
    if (!token) return next(Errors.auth());
    try {
      const claims = await tokens.verifyAccessToken(token);
      req.claims = claims;
      req.principal = {
        id: claims.sub,
        identifier: claims.ident,
        name: claims.nombre,
        role: claims.rol as UserRole,
        debeCambiarPassword: false,
        permissions: claims.perms,
      };
      next();
    } catch {
      next(Errors.auth());
    }
  };
}

export function authorize(recurso: string, action: PolicyAction): RequestHandler {
  return (req: AuthRequest, _res, next: NextFunction) => {
    if (!req.principal) return next(Errors.auth());
    if (!can(req.principal.permissions, recurso, action)) return next(Errors.forbidden());
    next();
  };
}

/** Doble envío CSRF: cookie (httpOnly=false) vs header `x-csrf-token`. */
export const csrfGuard: RequestHandler = (req: Request, _res, next: NextFunction) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIES.xsrf];
  const header = req.header('x-csrf-token');
  if (!cookie || !header || !constantTimeEqual(cookie, header)) {
    return next(Errors.forbidden('Token CSRF inválido. Recargue la página e intente de nuevo.'));
  }
  next();
};