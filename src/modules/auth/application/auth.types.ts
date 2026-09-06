// Proyecciones y tipos de la capa de aplicación del módulo auth.

export type UserRole = 'super_admin' | 'admin' | 'operador_monitoreo';

export interface PermissionFlags {
  ver: boolean;
  crear: boolean;
  editar: boolean;
  eliminar: boolean;
}

export interface PermissionsMap {
  [recurso: string]: PermissionFlags;
}

/** Principal autenticado — forma con la que el resto del sistema identifica al usuario. */
export interface AuthenticatedPrincipal {
  id: string;
  identifier: string;
  name: string;
  role: UserRole;
  debeCambiarPassword: boolean;
  permissions: PermissionsMap;
}

/** Claims almacenados en el JWT de acceso (corto) — incluyen permisos para RBAC sin DB. */
export interface AccessTokenClaims {
  sub: string;              // id del usuario
  tipo: 'user' | 'guardia';
  rol: string;
  ident: string;
  nombre: string;
  perms: PermissionsMap;
}

export interface AuthSessionMetadata {
  ip?: string;
  userAgent?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  principal: AuthenticatedPrincipal;
  /** Doble envío CSRF: el cliente debe enviarlo en el header x-csrf-token. */
  xsrf: string;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  principal: AuthenticatedPrincipal;
  xsrf: string;
}