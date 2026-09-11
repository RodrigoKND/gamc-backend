import type { AuthRepository, NewRefreshToken } from '@modules/auth/domain/auth.repository';
import type {
  GuardiaCredentialRow,
  GuardiaProfileRow,
  RefreshTokenRecord,
  RolePermissionRow,
  UserCredentialRow,
} from '@modules/auth/domain/entities';
import type { Tx } from '@infra/database';

type ResetCodeRecord = {
  sujetoTipo: 'user' | 'guardia';
  sujetoId: string;
  codigoHash: string;
  expiraEn: Date;
  usado: boolean;
};

export class InMemoryAuthRepository implements AuthRepository {
  users = new Map<string, UserCredentialRow>();
  refreshTokens = new Map<string, RefreshTokenRecord>();
  resetCodes: ResetCodeRecord[] = [];
  rolePermissions = new Map<string, RolePermissionRow[]>();

  lastLogin = new Map<string, number>();

  async findUserByIdentifier(identifier: string): Promise<UserCredentialRow | null> {
    const key = identifier.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === key || u.usuario.toLowerCase() === key) return u;
    }
    return null;
  }

  async findUserById(id: string): Promise<UserCredentialRow | null> {
    return this.users.get(id) ?? null;
  }

  async findGuardiaByIdentifier(_identifier: string): Promise<GuardiaCredentialRow | null> {
    return null;
  }

  async findGuardiaById(_id: string): Promise<GuardiaCredentialRow | null> {
    return null;
  }

  async findGuardiaProfileById(_id: string): Promise<GuardiaProfileRow | null> {
    return null;
  }

  async activateGuardiaWithToken(): Promise<GuardiaCredentialRow | null> {
    return null;
  }

  async activateGuardiaFirstLogin(): Promise<void> {
    void 0;
  }

  async findRoleById(roleId: string): Promise<{ codigo: string } | null> {
    for (const u of this.users.values()) {
      if (u.roleId === roleId) return { codigo: u.roleCodigo };
    }
    return null;
  }

  async updateUserLastLogin(userId: string): Promise<void> {
    this.lastLogin.set(userId, Date.now());
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, passwordHash });
  }

  async updateGuardiaPassword(): Promise<void> {
    void 0;
  }

  async activateUser(userId: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, estado: 'activo', debeCambiarPassword: false });
  }

  async storeResetCode(record: ResetCodeRecord): Promise<void> {
    this.resetCodes = this.resetCodes.filter(
      (r) => !(r.sujetoTipo === record.sujetoTipo && r.sujetoId === record.sujetoId && !r.usado),
    );
    this.resetCodes.push({ ...record });
  }

  async consumeResetCode(record: {
    sujetoTipo: 'user' | 'guardia';
    sujetoId: string;
    codigoHash: string;
  }): Promise<'ok' | 'invalid' | 'expired'> {
    for (const r of this.resetCodes) {
      if (r.sujetoTipo === record.sujetoTipo && r.sujetoId === record.sujetoId && r.codigoHash === record.codigoHash) {
        if (r.usado) return 'invalid';
        r.usado = true;
        return r.expiraEn.getTime() < Date.now() ? 'expired' : 'ok';
      }
    }
    return 'invalid';
  }

  async createRefreshToken(token: NewRefreshToken): Promise<void> {
    this.refreshTokens.set(token.tokenHash, {
      id: token.id,
      sujetoTipo: token.sujetoTipo,
      sujetoId: token.sujetoId,
      tokenHash: token.tokenHash,
      familia: token.familia,
      expiraEn: token.expiraEn,
      revocada: false,
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.refreshTokens.get(tokenHash) ?? null;
  }

  async rotateRefreshToken(revokedId: string, _replacementId: string): Promise<void> {
    for (const r of this.refreshTokens.values()) {
      if (r.id === revokedId) this.refreshTokens.set(r.tokenHash, { ...r, revocada: true });
    }
  }

  async revokeRefreshToken(tokenId: string): Promise<void> {
    for (const r of this.refreshTokens.values()) {
      if (r.id === tokenId) this.refreshTokens.set(r.tokenHash, { ...r, revocada: true });
    }
  }

  async revokeRefreshFamilia(familia: string): Promise<void> {
    for (const r of this.refreshTokens.values()) {
      if (r.familia === familia) this.refreshTokens.set(r.tokenHash, { ...r, revocada: true });
    }
  }

  async findTokensByFamilia(familia: string): Promise<RefreshTokenRecord[]> {
    return [...this.refreshTokens.values()].filter((r) => r.familia === familia);
  }

  async getPermissionsByRole(roleCodigo: string): Promise<RolePermissionRow[]> {
    return this.rolePermissions.get(roleCodigo) ?? [];
  }

  seedUser(user: UserCredentialRow, perms: RolePermissionRow[] = []): void {
    this.users.set(user.id, user);
    this.rolePermissions.set(user.roleCodigo, perms);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static noopTx(_tx: Tx): Tx {
    return _tx;
  }
}