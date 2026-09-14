import type { Response } from 'express';
import type { AuthenticatedPrincipal } from '@modules/auth/application/auth.types';
import { env } from '@config/env';

// Nombres y manejo de cookies de sesión. Los dos accesos (JWT) son
// httpOnly: el navegador nunca los expone a JS. `gamc_profile` es la única
// cookie legible por el cliente (sin secretos) que la web usa para el
// Sidebar/Topbar y el routing del middleware. `gamc_xsrf` es el token
// anti-CSRF de doble envío (se valida como header en mutaciones).

export const COOKIES = {
  access: 'gamc_access',
  refresh: 'gamc_refresh',
  profile: 'gamc_profile',
  xsrf: 'gamc_xsrf',
} as const;

const BASE_OPTIONS = {
  httpOnly: false,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
};

// Refresh con path '/' para que el middleware y cualquier Server Action pueda
// ver la cookie y hacer refresh silencioso sin redirigir a /login cada 15 min
const REFRESH_OPTIONS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
};

const ACCESS_OPTIONS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: env.ACCESS_TOKEN_MINUTES * 60 * 1000,
};

function serializeProfile(user: AuthenticatedPrincipal): string {
  return JSON.stringify({
    identifier: user.identifier,
    name: user.name,
    role: user.role,
  });
}

export interface SessionLike {
  accessToken: string;
  refreshToken: string;
  principal: AuthenticatedPrincipal;
  xsrf: string;
}

export function setSessionCookies(res: Response, session: SessionLike, xsrf: string): void {
  res.cookie(COOKIES.access, session.accessToken, ACCESS_OPTIONS);
  res.cookie(COOKIES.refresh, session.refreshToken, REFRESH_OPTIONS);
  // FIX 2026-09-18: perfil y xsrf antes expiraban a los 15 min (ACCESS_TOKEN_MINUTES)
  // por eso la web mostraba "Invitado" aunque el refresh siguiera vigente 7 días.
  // Ahora viven lo mismo que el refresh — el JWT httpOnly sigue siendo quien
  // decide el acceso real, el perfil solo es espejo para la UI.
  res.cookie(COOKIES.profile, serializeProfile(session.principal), {
    ...BASE_OPTIONS,
    maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  });
  // No httpOnly de propósito: la web necesita leerla para mandar el header.
  res.cookie(COOKIES.xsrf, xsrf, {
    ...BASE_OPTIONS,
    maxAge: env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(COOKIES.access, { ...ACCESS_OPTIONS, maxAge: undefined });
  res.clearCookie(COOKIES.refresh, { ...REFRESH_OPTIONS, maxAge: undefined });
  res.clearCookie(COOKIES.profile, { ...BASE_OPTIONS, maxAge: undefined });
  res.clearCookie(COOKIES.xsrf, { ...BASE_OPTIONS, maxAge: undefined });
}