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
  /** Cómo llegó el token: `bearer` (app móvil) o `cookie` (web). */
  authVia?: 'bearer' | 'cookie';
}

function extractBearer(req: Request): string | undefined {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value.trim();
}

// `authenticate` acepta el JWT de acceso por DOS vías:
//  · Authorization: Bearer <jwt>   → app móvil (guardias), sin cookies
//  · cookie `gamc_access` httpOnly  → plataforma web
export function authenticate(tokens: TokenService): RequestHandler {
  return async (req: AuthRequest, _res, next: NextFunction) => {
    const bearer = extractBearer(req);
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[COOKIES.access];
    const token = bearer ?? cookieToken;
    if (!token) return next(Errors.auth());
    try {
      const claims = await tokens.verifyAccessToken(token);
      req.claims = claims;
      req.authVia = bearer ? 'bearer' : 'cookie';
      req.principal = {
        id: claims.sub,
        identifier: claims.ident,
        name: claims.nombre,
        role: claims.rol as UserRole | 'guardia',
        debeCambiarPassword: false,
        permissions: claims.perms ?? {},
      };
      next();
    } catch {
      next(Errors.auth());
    }
  };
}

/** Exige que la sesión sea de un guardia (JWT `tipo = 'guardia'`, típicamente por Bearer). */
export const requireGuardia: RequestHandler = (req: AuthRequest, _res, next: NextFunction) => {
  if (!req.principal) return next(Errors.auth());
  if (req.claims?.tipo !== 'guardia') {
    return next(Errors.forbidden('Este endpoint es exclusivo de la app de guardias.'));
  }
  next();
};

/**
 * Deja pasar a los guardias (app móvil) y, para el resto, aplica el chequeo
 * de permisos web habitual. Útil en endpoints compartidos (p. ej. catálogos).
 */
export function authorizeWebOrGuardia(recurso: string, action: PolicyAction): RequestHandler {
  const web = authorize(recurso, action);
  return (req: AuthRequest, res, next: NextFunction) => {
    if (req.claims?.tipo === 'guardia') return next();
    return web(req, res, next);
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
  // Sesión por Bearer (app móvil): no hay cookie ambiente que un tercero pueda
  // forzar, así que el CSRF de doble envío no aplica.
  if (extractBearer(req)) return next();
  const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIES.xsrf];
  const header = req.header('x-csrf-token');
  if (!cookie || !header || !constantTimeEqual(cookie, header)) {
    return next(Errors.forbidden('Token CSRF inválido. Recargue la página e intente de nuevo.'));
  }
  next();
};