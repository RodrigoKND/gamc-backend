import type { Tx } from '@infra/database';
import type {
  GuardiaCredentialRow,
  GuardiaProfileRow,
  PasswordResetRecord,
  RefreshTokenRecord,
  RolePermissionRow,
  SujetoTipo,
  UserCredentialRow,
} from './entities.js';

// Contrato de persistencia del módulo auth (patrón Repository). El código de
// aplicación depende SOLO de esta interfaz — la implementación concreta
// (PostgresAuthRepository / InMemoryAuthRepository en tests) es intercambiable.

export interface NewRefreshToken {
  id: string;
  sujetoTipo: SujetoTipo;
  sujetoId: string;
  tokenHash: string;
  familia: string;
  expiraEn: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthRepository {
  findUserByIdentifier(identifier: string, tx?: Tx): Promise<UserCredentialRow | null>;
  findUserById(id: string, tx?: Tx): Promise<UserCredentialRow | null>;
  findGuardiaByIdentifier(identifier: string, tx?: Tx): Promise<GuardiaCredentialRow | null>;
  findGuardiaById(id: string, tx?: Tx): Promise<GuardiaCredentialRow | null>;
  /** Ficha pública del guardia (con su EPI) para las respuestas del auth móvil. */
  findGuardiaProfileById(id: string, tx?: Tx): Promise<GuardiaProfileRow | null>;
  /**
   * Activación (primer login, BD_UNIFICADA §5): fija password/estado si el
   * `usuario` + `token` coinciden y el token no expiró. Devuelve la fila ya
   * activada o `null` si no hubo coincidencia.
   */
  activateGuardiaWithToken(
    usuario: string,
    activacionToken: string,
    passwordHash: string,
    tx?: Tx,
  ): Promise<GuardiaCredentialRow | null>;

  findRoleById(roleId: string, tx?: Tx): Promise<{ codigo: string } | null>;
  updateUserLastLogin(userId: string, tx?: Tx): Promise<void>;
  updateUserPassword(userId: string, passwordHash: string, tx?: Tx): Promise<void>;
  updateGuardiaPassword(guardiaId: string, passwordHash: string, tx?: Tx): Promise<void>;
  /** Marca la cuenta como activa y aclara el flag de primer login (activación web/guardia). */
  activateUser(userId: string, tx?: Tx): Promise<void>;
  /** `pendiente_activacion` es solo informativo ("¿ya inició sesión alguna vez?") — este marca ese primer login, sin tocar contraseña ni ningún otro campo. */
  activateGuardia(guardiaId: string, tx?: Tx): Promise<void>;

  /** Almacena el hash del código de recuperación; revoca códigos previos sin usar. */
  storeResetCode(record: {
    sujetoTipo: SujetoTipo;
    sujetoId: string;
    codigoHash: string;
    expiraEn: Date;
  }, tx?: Tx): Promise<void>;
  /** Busca un código sin usar; lo marca usado (un solo uso). Distingue inválido vs expirado. */
  consumeResetCode(record: {
    sujetoTipo: SujetoTipo;
    sujetoId: string;
    codigoHash: string;
  }, tx?: Tx): Promise<'ok' | 'invalid' | 'expired'>;

  createRefreshToken(newToken: NewRefreshToken, tx?: Tx): Promise<void>;
  findRefreshTokenByHash(tokenHash: string, tx?: Tx): Promise<RefreshTokenRecord | null>;
  /** Revoca un token (rotación normal) y marca a cuál reemplazó. */
  rotateRefreshToken(revokedId: string, replacementId: string, tx?: Tx): Promise<void>;
  /** Revoca un token individual (logout). */
  revokeRefreshToken(tokenId: string, tx?: Tx): Promise<void>;
  /** Revoca toda la familia ante detección de reuso (token robado). */
  revokeRefreshFamilia(familia: string, tx?: Tx): Promise<void>;
  findTokensByFamilia(familia: string, tx?: Tx): Promise<RefreshTokenRecord[]>;

  getPermissionsByRole(roleCodigo: string, tx?: Tx): Promise<RolePermissionRow[]>;
}