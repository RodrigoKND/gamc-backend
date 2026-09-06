import type { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { nombreCompleto } from '@shared/names';
import type { AuditInput } from '@modules/auth/application/auth.service';

export interface AuditListParams {
  page: number;
  limit: number;
  accion?: string;
  recurso?: string;
}

export interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorNombre: string | null;
  actorTipo: string;
  accion: string;
  recurso: string | null;
  recursoId: string | null;
  detalle: Prisma.JsonValue | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// Traza inmutable de acciones sensibles (login, cambios de estado, asignación
// de rutas...). El trigger de la BD impide update/delete; la API solo inserta.

export async function logAudit(input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorTipo: input.actorTipo ?? 'user',
      accion: input.accion,
      recurso: input.recurso ?? null,
      recursoId: input.recursoId ?? null,
      detalle: (input.detalle ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export async function listAudit(params: AuditListParams): Promise<{ rows: AuditRow[]; total: number; page: number; limit: number }> {
  const where: Prisma.AuditLogWhereInput = {
    ...(params.accion ? { accion: { contains: params.accion, mode: 'insensitive' } } : {}),
    ...(params.recurso ? { recurso: { equals: params.recurso } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      include: {
        actorUser: {
          select: { primerNombre: true, segundoNombre: true, apellidoPaterno: true, apellidoMaterno: true },
        },
      },
    }),
    db.auditLog.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id.toString(),
      actorUserId: row.actorUserId,
      actorNombre: row.actorUser ? nombreCompleto(row.actorUser) : null,
      actorTipo: row.actorTipo,
      accion: row.accion,
      recurso: row.recurso,
      recursoId: row.recursoId,
      detalle: row.detalle,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    })),
    total,
    page: params.page,
    limit: params.limit,
  };
}