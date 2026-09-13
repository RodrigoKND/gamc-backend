import type { PrismaClient, Prisma } from '@prisma/client';
import { Tx } from '@infra/database';
import { nombreCompleto } from '@shared/names';
import type {
  GuardiaCredentialRow,
  GuardiaProfileRow,
  PasswordResetRecord,
  RefreshTokenRecord,
  RolePermissionRow,
  SujetoTipo,
  UserCredentialRow,
} from '../domain/entities.js';
import type { AuthRepository, NewRefreshToken } from '../domain/auth.repository.js';

type Client = PrismaClient | Prisma.TransactionClient;

const SUJETO_AUTH_MAP: Record<string, SujetoTipo> = { user: 'user', guardia: 'guardia' };
const GUARDIA_ESTADO_MAP = {
  pendiente_activacion: 'pendiente_activacion',
  activo: 'activo',
  inactivo: 'inactivo',
  suspendido: 'suspendido',
} as const;

// Implementación del repositorio auth con Prisma. La BD conserva la columna
// GENERATED `nombre`; el cliente no la conoce, así que la reconstruimos aquí
// con la MISMA lógica del schema (`trim(concat_ws(' ', ...))`).

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly db: Client) {}

  private get client(): Client {
    return this.db;
  }

  async findUserByIdentifier(identifier: string): Promise<UserCredentialRow | null> {
    const row = await this.client.user.findFirst({
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { usuario: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { role: { select: { codigo: true } } },
    });
    if (!row) return null;
    return this.toUserRow(row, row.role.codigo);
  }

  async findUserById(id: string): Promise<UserCredentialRow | null> {
    const row = await this.client.user.findUnique({
      where: { id },
      include: { role: { select: { codigo: true } } },
    });
    if (!row) return null;
    return this.toUserRow(row, row.role.codigo);
  }

  async findGuardiaByIdentifier(identifier: string): Promise<GuardiaCredentialRow | null> {
    const row = await this.client.guardia.findFirst({
      where: { usuario: { equals: identifier, mode: 'insensitive' } },
    });
    if (!row) return null;
    return this.toGuardiaRow(row);
  }

  async findGuardiaById(id: string): Promise<GuardiaCredentialRow | null> {
    const row = await this.client.guardia.findUnique({ where: { id } });
    if (!row) return null;
    return this.toGuardiaRow(row);
  }

  async findGuardiaProfileById(id: string): Promise<GuardiaProfileRow | null> {
    const row = await this.client.guardia.findUnique({
      where: { id },
      include: { epi: { select: { codigo: true, nombre: true } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      usuario: row.usuario,
      nombre: nombreCompleto(row),
      ci: row.ci,
      telefono: row.telefono,
      fotoUrl: row.fotoUrl,
      estado: GUARDIA_ESTADO_MAP[row.estado as keyof typeof GUARDIA_ESTADO_MAP] ?? 'pendiente_activacion',
      estadoOperativo: row.estadoOperativo as GuardiaProfileRow['estadoOperativo'],
      debeCambiarPassword: row.debeCambiarPassword,
      epiId: row.epiId,
      epiCodigo: row.epi?.codigo ?? null,
      epiNombre: row.epi?.nombre ?? null,
    };
  }

  async activateGuardiaWithToken(
    usuario: string,
    activacionToken: string,
    passwordHash: string,
  ): Promise<GuardiaCredentialRow | null> {
    // Update condicional (BD_UNIFICADA §5): solo aplica si usuario+token
    // coinciden, el token sigue vigente y la cuenta está pendiente.
    const res = await this.client.guardia.updateMany({
      where: {
        usuario: { equals: usuario, mode: 'insensitive' },
        activacionToken,
        activacionExpira: { gt: new Date() },
        estado: 'pendiente_activacion',
      },
      data: {
        passwordHash,
        estado: 'activo',
        activadoEn: new Date(),
        activacionToken: null,
        activacionExpira: null,
        debeCambiarPassword: false,
      },
    });
    if (res.count === 0) return null;
    return this.findGuardiaByIdentifier(usuario);
  }

  async findRoleById(roleId: string): Promise<{ codigo: string } | null> {
    const row = await this.client.role.findUnique({ where: { id: roleId }, select: { codigo: true } });
    return row ?? null;
  }

  async updateUserLastLogin(userId: string): Promise<void> {
    await this.client.user.update({ where: { id: userId }, data: { ultimoLogin: new Date() } });
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.client.user.update({
      where: { id: userId },
      data: { passwordHash, debeCambiarPassword: false },
    });
  }

  async updateGuardiaPassword(guardiaId: string, passwordHash: string): Promise<void> {
    await this.client.guardia.update({
      where: { id: guardiaId },
      data: {
        passwordHash,
        debeCambiarPassword: false,
        estado: 'activo',
        activadoEn: new Date(),
      },
    });
  }

  async activateUser(userId: string): Promise<void> {
    await this.client.user.update({ where: { id: userId }, data: { estado: 'activo' } });
  }

  async storeResetCode(record: {
    sujetoTipo: SujetoTipo;
    sujetoId: string;
    codigoHash: string;
    expiraEn: Date;
  }): Promise<void> {
    // Revoca códigos previos sin usar del mismo sujeto (contrato: un solo vigente).
    await this.client.passwordReset.updateMany({
      where: { sujetoTipo: record.sujetoTipo, sujetoId: record.sujetoId, usado: false },
      data: { usado: true },
    });
    await this.client.passwordReset.create({
      data: {
        sujetoTipo: record.sujetoTipo,
        sujetoId: record.sujetoId,
        codigoHash: record.codigoHash,
        expiraEn: record.expiraEn,
      },
    });
  }

  async consumeResetCode(record: {
    sujetoTipo: SujetoTipo;
    sujetoId: string;
    codigoHash: string;
  }): Promise<'ok' | 'invalid' | 'expired'> {
    const row = await this.client.passwordReset.findFirst({
      where: { sujetoTipo: record.sujetoTipo, sujetoId: record.sujetoId, usado: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.codigoHash !== record.codigoHash) return 'invalid';
    if (row.expiraEn.getTime() < Date.now()) return 'expired';
    await this.client.passwordReset.update({ where: { id: row.id }, data: { usado: true } });
    return 'ok';
  }

  async createRefreshToken(newToken: NewRefreshToken, tx?: Tx): Promise<void> {
    await (tx ?? this.client).refreshToken.create({
      data: {
        id: newToken.id,
        sujetoTipo: newToken.sujetoTipo,
        sujetoId: newToken.sujetoId,
        tokenHash: newToken.tokenHash,
        familia: newToken.familia,
        expiraEn: newToken.expiraEn,
        ip: newToken.ip ?? null,
        userAgent: newToken.userAgent ?? null,
      },
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.client.refreshToken.findFirst({ where: { tokenHash } });
    if (!row) return null;
    return {
      id: row.id,
      sujetoTipo: SUJETO_AUTH_MAP[row.sujetoTipo] ?? 'user',
      sujetoId: row.sujetoId,
      tokenHash: row.tokenHash,
      familia: row.familia,
      expiraEn: row.expiraEn,
      revocada: row.revocada,
    };
  }

  async rotateRefreshToken(revokedId: string, replacementId: string, tx?: Tx): Promise<void> {
    await (tx ?? this.client).refreshToken.update({
      where: { id: revokedId },
      data: { revocada: true, reemplazadaPorId: replacementId, usedAt: new Date() },
    });
  }

  async revokeRefreshToken(tokenId: string): Promise<void> {
    await this.client.refreshToken.update({
      where: { id: tokenId },
      data: { revocada: true, usedAt: new Date() },
    });
  }

  async revokeRefreshFamilia(familia: string): Promise<void> {
    await this.client.refreshToken.updateMany({
      where: { familia, revocada: false },
      data: { revocada: true },
    });
  }

  async findTokensByFamilia(familia: string): Promise<RefreshTokenRecord[]> {
    const rows = await this.client.refreshToken.findMany({ where: { familia } });
    return rows.map((row) => ({
      id: row.id,
      sujetoTipo: SUJETO_AUTH_MAP[row.sujetoTipo] ?? 'user',
      sujetoId: row.sujetoId,
      tokenHash: row.tokenHash,
      familia: row.familia,
      expiraEn: row.expiraEn,
      revocada: row.revocada,
    }));
  }

  async getPermissionsByRole(roleCodigo: string): Promise<RolePermissionRow[]> {
    const rows = await this.client.rolePermission.findMany({
      where: { role: { codigo: roleCodigo } },
      select: {
        recurso: true,
        puedeVer: true,
        puedeCrear: true,
        puedeEditar: true,
        puedeEliminar: true,
      },
    });
    return rows;
  }

  private toUserRow(
    row: { primerNombre: string; segundoNombre: string | null; apellidoPaterno: string; apellidoMaterno: string; id: string; roleId: string; email: string; usuario: string; passwordHash: string; estado: string; debeCambiarPassword: boolean },
    roleCodigo: string,
  ): UserCredentialRow {
    return {
      id: row.id,
      roleCodigo,
      roleId: row.roleId,
      nombre: nombreCompleto(row),
      email: row.email,
      usuario: row.usuario,
      passwordHash: row.passwordHash,
      estado: (row.estado as UserCredentialRow['estado']) ?? 'activo',
      debeCambiarPassword: row.debeCambiarPassword,
    };
  }

  private toGuardiaRow(row: {
    id: string;
    primerNombre: string;
    segundoNombre: string | null;
    apellidoPaterno: string;
    apellidoMaterno: string;
    usuario: string;
    passwordHash: string | null;
    estado: string;
    debeCambiarPassword: boolean;
  }): GuardiaCredentialRow {
    return {
      id: row.id,
      nombre: nombreCompleto(row),
      usuario: row.usuario,
      passwordHash: row.passwordHash,
      estado: GUARDIA_ESTADO_MAP[row.estado as keyof typeof GUARDIA_ESTADO_MAP] ?? 'pendiente_activacion',
      debeCambiarPassword: row.debeCambiarPassword,
    };
  }
}