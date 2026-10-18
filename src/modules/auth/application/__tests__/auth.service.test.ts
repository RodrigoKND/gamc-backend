import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Tx } from '@infra/database';
import { Errors, AppError } from '@shared/errors';
import { AuthService, type AuditInput } from '@modules/auth/application/auth.service';
import { PasswordService } from '@modules/auth/application/password.service';
import { RefreshTokenIssuer, TokenService } from '@modules/auth/application/token.service';
import { InMemoryAuthRepository } from './InMemoryAuthRepository.js';

const SUPER_ADMIN_PERMS = [
  { recurso: 'usuarios', puedeVer: true, puedeCrear: true, puedeEditar: true, puedeEliminar: true },
  { recurso: 'guardias', puedeVer: true, puedeCrear: true, puedeEditar: true, puedeEliminar: true },
];

const ADM_PERMS = [{ recurso: 'usuarios', puedeVer: true, puedeCrear: false, puedeEditar: true, puedeEliminar: false }];

function buildService(repo: InMemoryAuthRepository) {
  const audit = vi.fn<(input: AuditInput) => Promise<void>>();
  const service = new AuthService({
    repo,
    tokens: new TokenService(),
    refreshIssuer: RefreshTokenIssuer,
    audit,
    withTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(undefined as unknown as Tx),
  });
  return { service, audit };
}

async function seedActiveAdmin(repo: InMemoryAuthRepository, hash: string) {
  const row = {
    id: 'u-admin',
    roleCodigo: 'admin',
    roleId: 'role-admin',
    nombre: 'Carlos Mendoza Toro',
    email: 'carlos.mendoza@cochabamba.bo',
    usuario: 'carlos.mendoza',
    passwordHash: hash,
    estado: 'activo' as const,
    debeCambiarPassword: false,
  };
  repo.seedUser(row, ADM_PERMS);
  return row;
}

describe('AuthService', () => {
  let sharedHash = '';

  beforeAll(async () => {
    sharedHash = await PasswordService.hash('Admin#2025');
  });

  describe('login', () => {
    it('devuelve accessToken + refreshToken + principal con permisos', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const res = await service.login('carlos.mendoza@cochabamba.bo', 'Admin#2025', {});

      expect(res.accessToken).toBeTruthy();
      expect(res.refreshToken).toBeTruthy();
      expect(res.xsrf).toBeTruthy();
      expect(res.principal.role).toBe('admin');
      expect(res.principal.permissions.usuarios?.editar).toBe(true);
      expect(res.principal.permissions.usuarios?.crear).toBe(false);
    });

    it('login por usuario (sin @) también resuelve', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      await expect(service.login('carlos.mendoza', 'Admin#2025', {})).resolves.toBeTruthy();
    });

    it('contraseña incorrecta → INVALID_CREDENTIALS (401)', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const err = await service.login('carlos.mendoza@cochabamba.bo', 'wrong', {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(401);
      expect((err as AppError).code).toBe(Errors.invalidCredentials().code);
    });

    it('cuenta no activa → ACCOUNT_DISABLED (403)', async () => {
      const repo = new InMemoryAuthRepository();
      const row = await seedActiveAdmin(repo, sharedHash);
      repo.users.set(row.id, { ...row, estado: 'suspendido' });
      const { service } = buildService(repo);

      const err = await service.login('carlos.mendoza@cochabamba.bo', 'Admin#2025', {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(403);
    });
  });

  describe('refresh (rotación)', () => {
    it('rotación normal: token nuevo sirve; el viejo se revoca', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const login = await service.login('carlos.mendoza', 'Admin#2025', { ip: '1.2.3.4' });
      const rotated = await service.refresh(login.refreshToken, {});

      expect(rotated.accessToken).toBeTruthy();
      expect(rotated.refreshToken).not.toBe(login.refreshToken);

      // El token viejo ya está revocado → reuso detectado.
      await expect(service.refresh(login.refreshToken, {})).rejects.toMatchObject({ status: 401 });
    });

    it('token revocado por logout ya no refresca', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const login = await service.login('carlos.mendoza', 'Admin#2025', {});
      await service.logout(login.refreshToken);
      await expect(service.refresh(login.refreshToken, {})).rejects.toMatchObject({ status: 401 });
    });

    it('token inexistente → 401', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);
      await expect(service.refresh('no.getulo', {})).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('recuperación de contraseña', () => {
    it('identifier desconocido → accepta sin enumerar cuentas', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const res = await service.requestRecovery('nadie@cochabamba.bo');
      expect(res.accepted).toBe(true);
    });

    it('identifier válido → accepta y entrega código en dev', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const res = await service.requestRecovery('carlos.mendoza@cochabamba.bo');
      expect(res.accepted).toBe(true);
      expect(res.code).toMatch(/^\d{6}$/);
    });

    it('confirmRecovery con código correcto actualiza el hash y reactiva la cuenta', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const req = await service.requestRecovery('carlos.mendoza');
      await service.confirmRecovery('carlos.mendoza', req.code!, 'Nueva#Clave9');

      const user = repo.users.get('u-admin')!;
      expect(user.debeCambiarPassword).toBe(false);
      expect(user.estado).toBe('activo');
      await expect(service.login('carlos.mendoza', 'Nueva#Clave9', {})).resolves.toBeTruthy();
      await expect(service.login('carlos.mendoza', 'Admin#2025', {})).rejects.toMatchObject({ status: 401 });
    });

    it('código incorrecto → RESET_CODE_INVALID', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      await service.requestRecovery('carlos.mendoza');
      await expect(service.confirmRecovery('carlos.mendoza', '000000', 'Nueva#Clave9')).rejects.toMatchObject({
        code: Errors.resetCodeInvalid().code,
      });
    });

    it('código expirado → RESET_CODE_EXPIRED', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const req = await service.requestRecovery('carlos.mendoza');
      for (const r of repo.resetCodes) r.expiraEn = new Date(Date.now() - 1);
      await expect(service.confirmRecovery('carlos.mendoza', req.code!, 'Nueva#Clave9')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('changePassword', () => {
    it('contraseña actual incorrecta → VALIDATION_ERROR', async () => {
      const repo = new InMemoryAuthRepository();
      const row = await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const principal = {
        id: row.id,
        identifier: row.email,
        name: row.nombre,
        role: 'admin' as const,
        debeCambiarPassword: false,
        permissions: { usuarios: { ver: true, crear: false, editar: true, eliminar: false } },
      };
      await expect(service.changePassword(principal, 'nope', 'Nueva#Clave9')).rejects.toMatchObject({
        code: Errors.validation('x').code,
      });
    });

    it('cambio correcto: la nueva contraseña entra y la vieja no', async () => {
      const repo = new InMemoryAuthRepository();
      const row = await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const principal = {
        id: row.id,
        identifier: row.email,
        name: row.nombre,
        role: 'admin' as const,
        debeCambiarPassword: true,
        permissions: {},
      };
      await service.changePassword(principal, 'Admin#2025', 'Nueva#Clave9');
      await expect(service.login('carlos.mendoza', 'Nueva#Clave9', {})).resolves.toBeTruthy();
    });
  });

  describe('me', () => {
    it('levanta el principal desde el accessToken', async () => {
      const repo = new InMemoryAuthRepository();
      await seedActiveAdmin(repo, sharedHash);
      const { service } = buildService(repo);

      const login = await service.login('carlos.mendoza', 'Admin#2025', {});
      const me = await service.me(login.accessToken);
      expect(me.id).toBe('u-admin');
      expect(me.permissions.usuarios?.ver).toBe(true);
    });
  });
});
