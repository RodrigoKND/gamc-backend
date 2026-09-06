import type { PermissionsMap } from '@modules/auth/application/auth.types';

// RBAC (matriz role_permission de la BD reflejada en memoria). `can` es la
// ÚNICA función que decide si un principal puede tocar un recurso. La usan
// el middleware `authorize` (backend, defensa real) — el frontend solo
// oculta ítems por UX.

export type PolicyAction = 'ver' | 'crear' | 'editar' | 'eliminar';

const ACTION_KEY: Record<PolicyAction, 'ver' | 'crear' | 'editar' | 'eliminar'> = {
  ver: 'ver',
  crear: 'crear',
  editar: 'editar',
  eliminar: 'eliminar',
};

export const RECURSOS = [
  'usuarios',
  'guardias',
  'roles',
  'hechos',
  'patrullaje',
  'mapas',
  'auditoria',
  'reportes',
] as const;

export type Recurso = (typeof RECURSOS)[number];

export function can(perms: PermissionsMap, recurso: string, action: PolicyAction): boolean {
  return Boolean(perms[recurso]?.[ACTION_KEY[action]]);
}

export function requirePolicy(perms: PermissionsMap, recurso: string, action: PolicyAction): void {
  if (!can(perms, recurso, action)) {
    throw new Error('FORBIDDEN');
  }
}