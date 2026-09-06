import type { NextFunction, Request, Response } from 'express';
import { Errors, validate } from '@shared/index';
import { COOKIES, clearSessionCookies, setSessionCookies } from '@shared/cookies';
import type { AuthSessionMetadata } from '../application/auth.types.js';
import type { AuthService } from '../application/auth.service.js';
import {
  changePasswordSchema,
  confirmRecoverySchema,
  loginSchema,
  requestRecoverySchema,
} from '../application/auth.schemas.js';
import type { AuthRequest } from './middlewares.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Proyección pública del principal (sin la matriz de permisos). */
function publicPrincipal(principal: { id: string; identifier: string; name: string; role: string; debeCambiarPassword: boolean }) {
  return {
    id: principal.id,
    identifier: principal.identifier,
    name: principal.name,
    role: principal.role,
    debeCambiarPassword: principal.debeCambiarPassword ?? false,
  };
}

function sessionMeta(req: Request): AuthSessionMetadata {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

export interface AuthController {
  login: ReturnType<typeof ah>;
  logout: ReturnType<typeof ah>;
  refresh: ReturnType<typeof ah>;
  me: ReturnType<typeof ah>;
  requestRecovery: ReturnType<typeof ah>;
  confirmRecovery: ReturnType<typeof ah>;
  changePassword: ReturnType<typeof ah>;
}

export function createAuthController(service: AuthService): AuthController {
  return {
    login: ah(async (req, res) => {
      const { identifier, password } = validate(loginSchema, req.body);
      const session = await service.login(identifier, password, sessionMeta(req));
      setSessionCookies(res, session, session.xsrf);
      res.json({ data: { principal: publicPrincipal(session.principal) } });
    }),

    logout: ah(async (req, res) => {
      const raw = (req.cookies as Record<string, string> | undefined)?.[COOKIES.refresh];
      await service.logout(raw);
      clearSessionCookies(res);
      res.json({ data: { ok: true } });
    }),

    refresh: ah(async (req, res) => {
      const raw = (req.cookies as Record<string, string> | undefined)?.[COOKIES.refresh];
      if (!raw) throw Errors.auth('Sesión expirada. Ingrese nuevamente.');
      const session = await service.refresh(raw, sessionMeta(req));
      setSessionCookies(res, session, session.xsrf);
      res.json({
        data: {
          principal: publicPrincipal(session.principal),
          accessTokenExpiresIn: 900,
        },
      });
    }),

    me: ah(async (req: AuthRequest, res) => {
      if (!req.principal) throw Errors.auth();
      res.json({ data: { principal: publicPrincipal(req.principal) } });
    }),

    requestRecovery: ah(async (req, res) => {
      const { identifier } = validate(requestRecoverySchema, req.body);
      const result = await service.requestRecovery(identifier);
      res.json({
        data: {
          accepted: result.accepted,
          expiresAt: result.expiresAt,
          ...(result.code ? { devCode: result.code } : {}),
        },
      });
    }),

    confirmRecovery: ah(async (req, res) => {
      const { identifier, code, newPassword } = validate(confirmRecoverySchema, req.body);
      await service.confirmRecovery(identifier, code, newPassword);
      res.json({ data: { ok: true } });
    }),

    changePassword: ah(async (req: AuthRequest, res) => {
      if (!req.principal) throw Errors.auth();
      const { currentPassword, newPassword } = validate(changePasswordSchema, req.body);
      await service.changePassword(req.principal, currentPassword, newPassword);
      res.json({ data: { ok: true } });
    }),
  };
}