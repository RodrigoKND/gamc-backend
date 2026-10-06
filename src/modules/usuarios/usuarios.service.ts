import { Prisma, user_estado } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { PasswordService } from '@modules/auth/application/password.service';
import { randomTemporaryPassword } from '@shared/security';
import { logAudit } from '@modules/auditoria/auditoria.service';

export interface CreateUserInput {
  rol: string;
  primerNombre: string;
  segundoNombre?: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
  email: string;
  usuario: string;
  ci?: string | null;
  telefono?: string | null;
  fechaNacimiento?: string | null;
  epiCodigo?: string | null;
  creadoPorId: string;
}

export interface UserRow {
  id: string;
  primerNombre: string;
  segundoNombre: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
  nombre: string;
  roleCodigo: string;
  roleNombre: string;
  email: string;
  usuario: string;
  ci: string | null;
  telefono: string | null;
  estado: string;
  debeCambiarPassword: boolean;
  ultimoLogin: Date | null;
  creadoPorNombre: string | null;
  createdAt: Date;
  epiCodigo: string | null;
  epiNombre: string | null;
}

function toUserRowObj(row: {
  id: string;
  primerNombre: string;
  segundoNombre: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
  email: string;
  usuario: string;
  ci: string | null;
  telefono: string | null;
  estado: string;
  debeCambiarPassword: boolean;
  ultimoLogin: Date | null;
  createdAt: Date;
  role: { codigo: string; nombre: string };
  epi?: { codigo: string; nombre: string } | null;
  creadoPor?: { primerNombre: string; segundoNombre: string | null; apellidoPaterno: string; apellidoMaterno: string } | null;
}): UserRow {
  return {
    id: row.id,
    primerNombre: row.primerNombre,
    segundoNombre: row.segundoNombre,
    apellidoPaterno: row.apellidoPaterno,
    apellidoMaterno: row.apellidoMaterno,
    nombre: nombreCompleto(row),
    roleCodigo: row.role.codigo,
    roleNombre: row.role.nombre,
    email: row.email,
    usuario: row.usuario,
    ci: row.ci,
    telefono: row.telefono,
    estado: row.estado,
    debeCambiarPassword: row.debeCambiarPassword,
    ultimoLogin: row.ultimoLogin,
    creadoPorNombre: row.creadoPor ? nombreCompleto(row.creadoPor) : null,
    createdAt: row.createdAt,
    epiCodigo: row.epi?.codigo ?? null,
    epiNombre: row.epi?.nombre ?? null,
  };
}

async function toUserRow(id: string, incluirCreador = true): Promise<UserRow | null> {
  const row = await db.user.findUnique({
    where: { id },
    include: {
      role: { select: { codigo: true, nombre: true } },
      epi: { select: { codigo: true, nombre: true } },
      creadoPor: incluirCreador
        ? { select: { primerNombre: true, segundoNombre: true, apellidoPaterno: true, apellidoMaterno: true } }
        : false,
    },
  });
  if (!row) return null;
  return toUserRowObj(row);
}

export async function listRoles() {
  return db.role.findMany({
    orderBy: { codigo: 'asc' },
    select: { id: true, codigo: true, nombre: true, descripcion: true },
  });
}

export async function listUsers(): Promise<UserRow[]> {
  const rows = await db.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      role: { select: { codigo: true, nombre: true } },
      epi: { select: { codigo: true, nombre: true } },
      creadoPor: { select: { primerNombre: true, segundoNombre: true, apellidoPaterno: true, apellidoMaterno: true } },
    },
  });
  return rows.map((row) => toUserRowObj(row));
}

export async function createUser(input: CreateUserInput): Promise<{ user: UserRow; temporaryPassword: string }> {
  const role = await db.role.findUnique({ where: { codigo: input.rol } });
  if (!role) throw Errors.validation('El rol indicado no existe.');
  if (input.rol !== 'super_admin' && !input.epiCodigo) {
    throw Errors.validation('Debe asignar una EPI al usuario.');
  }
  const epi = input.epiCodigo
    ? await db.epi.findUnique({ where: { codigo: input.epiCodigo }, select: { id: true, activo: true } })
    : null;
  if (input.epiCodigo && !epi?.activo) throw Errors.validation('La EPI indicada no existe o está inactiva.');

  const temporalPassword = randomTemporaryPassword(12);
  const passwordHash = await PasswordService.hash(temporalPassword);

  try {
    const created = await db.user.create({
      data: {
        roleId: role.id,
        primerNombre: input.primerNombre,
        segundoNombre: input.segundoNombre ?? null,
        apellidoPaterno: input.apellidoPaterno,
        apellidoMaterno: input.apellidoMaterno,
        email: input.email,
        usuario: input.usuario,
        ci: input.ci ?? null,
        telefono: input.telefono ?? null,
        fechaNacimiento: input.fechaNacimiento ? new Date(input.fechaNacimiento) : null,
        passwordHash,
        estado: 'activo',
        debeCambiarPassword: true,
        creadoPorId: input.creadoPorId,
        epiId: epi?.id ?? null,
      },
    });
    const user = await toUserRow(created.id);
    if (!user) throw Errors.notFound('Usuario creado pero no encontrado.');
    await logAudit({
      actorUserId: input.creadoPorId,
      accion: 'crear_usuario',
      recurso: 'usuarios',
      recursoId: created.id,
      detalle: input,
    });
    return { user, temporaryPassword: temporalPassword };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw Errors.conflict('El email, usuario o CI ya está registrado.');
    }
    throw error;
  }
}

export async function updateUser(id: string, patch: Partial<CreateUserInput>): Promise<UserRow> {
  if (patch.epiCodigo) {
    const epi = await db.epi.findUnique({ where: { codigo: patch.epiCodigo }, select: { id: true, activo: true } });
    if (!epi?.activo) throw Errors.validation('La EPI indicada no existe o está inactiva.');
  }
  const data: Prisma.UserUpdateInput = {
    ...(patch.primerNombre !== undefined ? { primerNombre: patch.primerNombre } : {}),
    ...(patch.segundoNombre !== undefined ? { segundoNombre: patch.segundoNombre ?? null } : {}),
    ...(patch.apellidoPaterno !== undefined ? { apellidoPaterno: patch.apellidoPaterno } : {}),
    ...(patch.apellidoMaterno !== undefined ? { apellidoMaterno: patch.apellidoMaterno } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.usuario !== undefined ? { usuario: patch.usuario } : {}),
    ...(patch.ci !== undefined ? { ci: patch.ci ?? null } : {}),
    ...(patch.telefono !== undefined ? { telefono: patch.telefono ?? null } : {}),
    ...(patch.fechaNacimiento !== undefined ? { fechaNacimiento: patch.fechaNacimiento ? new Date(patch.fechaNacimiento) : null } : {}),
    ...(patch.epiCodigo !== undefined
      ? { epi: patch.epiCodigo ? { connect: { codigo: patch.epiCodigo } } : { disconnect: true } }
      : {}),
  };
  try {
    await db.user.update({ where: { id }, data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw Errors.conflict('El email, usuario o CI ya está registrado.');
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw Errors.notFound('Usuario no encontrado.');
    }
    throw error;
  }
  const user = await toUserRow(id);
  if (!user) throw Errors.notFound('Usuario no encontrado.');
  return user;
}

export async function setUserEstado(id: string, estado: user_estado, actorId: string): Promise<UserRow> {
  try {
    await db.user.update({ where: { id }, data: { estado } });
  } catch {
    throw Errors.notFound('Usuario no encontrado.');
  }
  const user = await toUserRow(id);
  if (!user) throw Errors.notFound('Usuario no encontrado.');
  await logAudit({ actorUserId: actorId, accion: `usuario_${estado}`, recurso: 'usuarios', recursoId: id });
  return user;
}
