// Entidades y tipos del dominio de autenticación. Los repositorios devuelven
// estas formas (filas de BD mapeadas) y la capa de aplicación responde con
// proyecciones (DTO) — las columnas de la BD nunca llegan tal cual al API.

export type SujetoTipo = 'user' | 'guardia';

export interface UserCredentialRow {
  id: string;
  roleCodigo: string;
  roleId: string;
  nombre: string;
  email: string;
  usuario: string;
  passwordHash: string;
  estado: 'activo' | 'inactivo' | 'suspendido';
  debeCambiarPassword: boolean;
}

export interface GuardiaCredentialRow {
  id: string;
  nombre: string;
  usuario: string;
  passwordHash: string | null;
  estado: 'pendiente_activacion' | 'activo' | 'inactivo' | 'suspendido';
  debeCambiarPassword: boolean;
}

/** Proyección pública de la ficha del guardia — la devuelve el auth móvil (login/activar/me). */
export interface GuardiaProfileRow {
  id: string;
  usuario: string;
  nombre: string;
  ci: string;
  telefono: string;
  fotoUrl: string | null;
  estado: 'pendiente_activacion' | 'activo' | 'inactivo' | 'suspendido';
  estadoOperativo: 'fuera_de_servicio' | 'en_servicio' | 'emergencia';
  debeCambiarPassword: boolean;
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
}

export interface RefreshTokenRecord {
  id: string;
  sujetoTipo: SujetoTipo;
  sujetoId: string;
  tokenHash: string;
  familia: string;
  expiraEn: Date;
  revocada: boolean;
}

export interface PasswordResetRecord {
  id: string;
  sujetoTipo: SujetoTipo;
  sujetoId: string;
  codigoHash: string;
  expiraEn: Date;
  usado: boolean;
}

export interface RolePermissionRow {
  recurso: string;
  puedeVer: boolean;
  puedeCrear: boolean;
  puedeEditar: boolean;
  puedeEliminar: boolean;
}