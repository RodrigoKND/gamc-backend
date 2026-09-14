import { env } from '@config/env';
import type { Tx } from '@infra/database';
import { Errors } from '@shared/errors';
import { newCsrfToken, randomResetCode, sha256 } from '@shared/security';
import type { AuthRepository } from '@modules/auth/domain/auth.repository';
import type {
  GuardiaCredentialRow,
  GuardiaProfileRow,
  RolePermissionRow,
  UserCredentialRow,
} from '@modules/auth/domain/entities';
import { PasswordService } from '@modules/auth/application/password.service';
import { RefreshTokenIssuer, TokenService } from '@modules/auth/application/token.service';
import type {
  AccessTokenClaims,
  AuthSessionMetadata,
  AuthenticatedPrincipal,
  LoginResponse,
  PermissionsMap,
  RefreshResult,
  UserRole,
} from '@modules/auth/application/auth.types';

export interface AuditInput {
  actorUserId: string | null;
  actorTipo?: 'user' | 'guardia' | 'sistema';
  accion: string;
  recurso?: string;
  recursoId?: string;
  detalle?: unknown;
  ip?: string;
  userAgent?: string;
}

/** Respuesta del auth móvil: tokens en el body (no cookies) + ficha del guardia. */
export interface GuardiaAuthResponse {
  accessToken: string;
  refreshToken: string;
  guardia: GuardiaProfileRow;
}

export interface AuthServiceDeps {
  repo: AuthRepository;
  tokens: TokenService;
  refreshIssuer: typeof RefreshTokenIssuer;
  audit: (input: AuditInput) => Promise<void>;
  /** Runner de transacciones inyectable (Prisma o identidad en tests). */
  withTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

function permissionsFrom(rows: RolePermissionRow[]): PermissionsMap {
  const map: PermissionsMap = {};
  for (const row of rows) {
    map[row.recurso] = { ver: row.puedeVer, crear: row.puedeCrear, editar: row.puedeEditar, eliminar: row.puedeEliminar };
  }
  return map;
}

function guardiaPrincipal(guardia: GuardiaCredentialRow): AuthenticatedPrincipal {
  return {
    id: guardia.id,
    identifier: guardia.usuario,
    name: guardia.nombre,
    role: 'guardia',
    debeCambiarPassword: guardia.debeCambiarPassword,
    permissions: {}, // los guardias no usan role_permission (BD_UNIFICADA §1)
  };
}

function principalFrom(
  user: UserCredentialRow,
  perms: PermissionsMap,
): AuthenticatedPrincipal {
  return {
    id: user.id,
    identifier: user.email,
    name: user.nombre,
    role: user.roleCodigo as UserRole,
    debeCambiarPassword: user.debeCambiarPassword,
    permissions: perms,
  };
}

export async function buildPrincipal(
  repo: AuthRepository,
  user: UserCredentialRow,
): Promise<AuthenticatedPrincipal> {
  const perms = permissionsFrom(await repo.getPermissionsByRole(user.roleCodigo));
  return principalFrom(user, perms);
}

// Orquesta los casos de uso de autenticación. NO conoce Express ni cookies:
// devuelve tokens+principal; el framework de presentación los escribe en las
// cookies. Esto mantiene la capa de aplicación testeable sin HTTP.

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async login(
    identifier: string,
    password: string,
    meta: AuthSessionMetadata,
  ): Promise<LoginResponse> {
   
    const user = await this.deps.repo.findUserByIdentifier(identifier);
    if (!user) throw Errors.invalidCredentials();
    if (user.estado !== 'activo') throw Errors.accountDisabled();
    
    const passwordOk = await PasswordService.verify(password, user.passwordHash);
    if (!passwordOk) throw Errors.invalidCredentials();
    
    const principal = await buildPrincipal(this.deps.repo, user);
    const session = await this.issueSession('user', user.id, user.nombre, principal, meta);
    await this.deps.repo.updateUserLastLogin(user.id);
    await this.deps.audit({
      actorUserId: user.id,
      accion: 'login',
      recurso: 'auth',
      recursoId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return session;
  }

  // ── Auth móvil (guardias) ─────────────────────────────────────────────────
  // Mismos primitivos que la web (issueSession, refresh rotativo) pero con
  // `sujeto_tipo = 'guardia'`, sin role_permission y devolviendo los tokens
  // en el JSON. El JWT lleva `sub = uuid del guardia` y `tipo = 'guardia'`.

  async loginGuardia(
    usuario: string,
    password: string,
    meta: AuthSessionMetadata,
  ): Promise<GuardiaAuthResponse> {
    const guardia = await this.deps.repo.findGuardiaByIdentifier(usuario);
    if (!guardia) throw Errors.invalidCredentials();
    if (guardia.estado === 'pendiente_activacion') throw Errors.guardiaPendienteActivacion();
    if (guardia.estado !== 'activo') throw Errors.accountDisabled();

    const ok = await PasswordService.verify(password, guardia.passwordHash);
    if (!ok) throw Errors.invalidCredentials();

    return this.issueGuardiaSession(guardia, meta, 'login');
  }

  /** Primer login: fija la contraseña y activa la cuenta (BD_UNIFICADA §5). */
  async activarGuardia(
    input: { usuario: string; activacionToken: string; password: string },
    meta: AuthSessionMetadata,
  ): Promise<GuardiaAuthResponse> {
    const passwordHash = await PasswordService.hash(input.password);
    const guardia = await this.deps.repo.activateGuardiaWithToken(
      input.usuario,
      input.activacionToken,
      passwordHash,
    );
    if (!guardia) throw Errors.activationInvalid();
    return this.issueGuardiaSession(guardia, meta, 'activar_guardia');
  }

  async refreshGuardia(
    rawRefreshToken: string,
    meta: AuthSessionMetadata,
  ): Promise<GuardiaAuthResponse> {
    const record = await this.deps.repo.findRefreshTokenByHash(sha256(rawRefreshToken));
    if (!record) throw Errors.auth();
    if (record.revocada) {
      await this.deps.repo.revokeRefreshFamilia(record.familia);
      throw Errors.auth('Su sesión fue renovada en otro dispositivo. Ingrese nuevamente.');
    }
    if (record.expiraEn.getTime() < Date.now()) throw Errors.auth();
    if (record.sujetoTipo !== 'guardia') throw Errors.auth();

    const guardia = await this.deps.repo.findGuardiaById(record.sujetoId);
    if (!guardia) throw Errors.auth();
    if (guardia.estado !== 'activo') throw Errors.accountDisabled();

    const pair = this.deps.refreshIssuer.issue(meta, record.familia);
    await this.deps.withTransaction(async (tx) => {
      // Crear ANTES de rotar: `refresh_token.reemplazada_por` es FK a
      // refresh_token(id), la fila nueva debe existir primero.
      await this.deps.repo.createRefreshToken(
        {
          id: pair.id,
          sujetoTipo: 'guardia',
          sujetoId: record.sujetoId,
          tokenHash: pair.hash,
          familia: pair.familia,
          expiraEn: pair.expiraEn,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      await this.deps.repo.rotateRefreshToken(record.id, pair.id, tx);
    });

    const accessToken = await this.deps.tokens.signAccessToken(
      this.deps.tokens.toClaims({
        id: guardia.id,
        tipo: 'guardia',
        rol: 'guardia',
        ident: guardia.usuario,
        nombre: guardia.nombre,
        permissions: {},
      }),
    );
    const profile = await this.requireGuardiaProfile(guardia.id);
    return { accessToken, refreshToken: pair.token, guardia: profile };
  }

  private async issueGuardiaSession(
    guardia: GuardiaCredentialRow,
    meta: AuthSessionMetadata,
    accion: 'login' | 'activar_guardia',
  ): Promise<GuardiaAuthResponse> {
    const session = await this.issueSession(
      'guardia',
      guardia.id,
      guardia.nombre,
      guardiaPrincipal(guardia),
      meta,
    );
    await this.deps.audit({
      actorUserId: null,
      actorTipo: 'guardia',
      accion,
      recurso: 'auth',
      recursoId: guardia.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const profile = await this.requireGuardiaProfile(guardia.id);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken, guardia: profile };
  }

  private async requireGuardiaProfile(id: string): Promise<GuardiaProfileRow> {
    const profile = await this.deps.repo.findGuardiaProfileById(id);
    if (!profile) throw Errors.auth();
    return profile;
  }

  /** Ficha del guardia autenticado (endpoint `GET /api/mobile/auth/me`). */
  async getGuardiaProfile(id: string): Promise<GuardiaProfileRow> {
    const profile = await this.requireGuardiaProfile(id);
    if (profile.estado !== 'activo') throw Errors.accountDisabled();
    return profile;
  }

  async refresh(rawRefreshToken: string, meta: AuthSessionMetadata): Promise<RefreshResult> {
    const hash = sha256(rawRefreshToken);
    const record = await this.deps.repo.findRefreshTokenByHash(hash);
    if (!record) throw Errors.auth();

    // Reuso del token original (rotación): significa que alguien está
    // presentando un token ya reemplazado → revocar toda la familia.
    if (record.revocada) {
      await this.deps.repo.revokeRefreshFamilia(record.familia);
      throw Errors.auth('Su sesión fue renovada en otro dispositivo. Ingrese nuevamente.');
    }
    if (record.expiraEn.getTime() < Date.now()) throw Errors.auth();

    // La web solo crea sesiones de usuarios (los guardias usan la app móvil).
    if (record.sujetoTipo !== 'user') throw Errors.auth();
    const user = await this.deps.repo.findUserById(record.sujetoId);
    if (!user) throw Errors.auth();
    if (user.estado !== 'activo') throw Errors.accountDisabled();

    const principal = await buildPrincipal(this.deps.repo, user);
    const pair = this.deps.refreshIssuer.issue(meta, record.familia);

    await this.deps.withTransaction(async (tx) => {
      // Crear ANTES de rotar: `refresh_token.reemplazada_por` es FK a
      // refresh_token(id), la fila nueva debe existir primero.
      await this.deps.repo.createRefreshToken(
        {
          id: pair.id,
          sujetoTipo: record.sujetoTipo,
          sujetoId: record.sujetoId,
          tokenHash: pair.hash,
          familia: pair.familia,
          expiraEn: pair.expiraEn,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      await this.deps.repo.rotateRefreshToken(record.id, pair.id, tx);
    });

    const accessToken = await this.deps.tokens.signAccessToken(this.deps.tokens.toClaims({
      id: principal.id,
      tipo: 'user',
      rol: principal.role,
      ident: principal.identifier,
      nombre: principal.name,
      permissions: principal.permissions,
    }));

    return { accessToken, refreshToken: pair.token, principal, xsrf: newCsrfToken() };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const record = await this.deps.repo.findRefreshTokenByHash(sha256(rawRefreshToken));
    if (record) await this.deps.repo.revokeRefreshToken(record.id);
  }

  async me(rawAccessToken: string): Promise<AuthenticatedPrincipal> {
    const claims = await this.deps.tokens.verifyAccessToken(rawAccessToken);
    const user = await this.deps.repo.findUserById(claims.sub);
    if (!user) throw Errors.auth();
    if (user.estado !== 'activo') throw Errors.accountDisabled();
    return buildPrincipal(this.deps.repo, user);
  }

  /** Solicita un código de recuperación. SIEMPRE responde aceptado (no enumerar cuentas). */
  async requestRecovery(identifier: string): Promise<{ accepted: true; expiresAt: Date; code?: string }> {
    const user = await this.deps.repo.findUserByIdentifier(identifier);
    if (user && user.estado === 'activo') {
      const code = randomResetCode(6);
      const expiresAt = new Date(Date.now() + env.RESET_CODE_MINUTES * 60_000);
      await this.deps.repo.storeResetCode({
        sujetoTipo: 'user',
        sujetoId: user.id,
        codigoHash: sha256(code),
        expiraEn: expiresAt,
      });
      await this.deps.audit({ actorUserId: user.id, accion: 'solicitar_reset', recurso: 'auth', recursoId: user.id });
      return { accepted: true, expiresAt, code: env.DEV_RETURN_RESET_CODE ? code : undefined };
    }
    return { accepted: true, expiresAt: new Date(Date.now() + env.RESET_CODE_MINUTES * 60_000) };
  }

  /** Confirma el código y fija la nueva contraseña (un solo uso). */
  async confirmRecovery(identifier: string, code: string, newPassword: string): Promise<void> {
    const user = await this.deps.repo.findUserByIdentifier(identifier);
    if (!user) throw Errors.resetCodeInvalid();

    const status = await this.deps.repo.consumeResetCode({
      sujetoTipo: 'user',
      sujetoId: user.id,
      codigoHash: sha256(code),
    });
    if (status === 'expired') throw Errors.resetCodeExpired();
    if (status === 'invalid') throw Errors.resetCodeInvalid();

    const passwordHash = await PasswordService.hash(newPassword);
    await this.deps.withTransaction(async (tx) => {
      await this.deps.repo.updateUserPassword(user.id, passwordHash, tx);
      await this.deps.repo.activateUser(user.id, tx);
    });
    await this.deps.audit({ actorUserId: user.id, accion: 'confirmar_reset', recurso: 'auth', recursoId: user.id });
  }

  /** Cambio de contraseña estando autenticado (también en el primer login). */
  async changePassword(principal: AuthenticatedPrincipal, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.deps.repo.findUserById(principal.id);
    if (!user) throw Errors.auth();
    const ok = await PasswordService.verify(currentPassword, user.passwordHash);
    if (!ok) throw Errors.validation('La contraseña actual es incorrecta.');

    const passwordHash = await PasswordService.hash(newPassword);
    await this.deps.repo.updateUserPassword(user.id, passwordHash);
    await this.deps.audit({ actorUserId: user.id, accion: 'cambiar_password', recurso: 'auth', recursoId: user.id });
  }

  private async issueSession(
    tipo: 'user' | 'guardia',
    id: string,
    nombre: string,
    principal: AuthenticatedPrincipal,
    meta: AuthSessionMetadata,
  ): Promise<LoginResponse> {
    const pair = this.deps.refreshIssuer.issue(meta);
    await this.deps.repo.createRefreshToken({
      id: pair.id,
      sujetoTipo: tipo,
      sujetoId: id,
      tokenHash: pair.hash,
      familia: pair.familia,
      expiraEn: pair.expiraEn,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const claims: AccessTokenClaims = this.deps.tokens.toClaims({
      id: principal.id,
      tipo,
      rol: principal.role,
      ident: principal.identifier,
      nombre,
      permissions: principal.permissions,
    });
    const accessToken = await this.deps.tokens.signAccessToken(claims);
    return { accessToken, refreshToken: pair.token, principal, xsrf: newCsrfToken() };
  }
}