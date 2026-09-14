import { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { PasswordService } from '@modules/auth/application/password.service';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { peekAddress } from '@modules/mapas/geocoding.service.js';

export type EstadoOperativo = 'fuera_de_servicio' | 'en_servicio' | 'emergencia';
export type EstadoCuentaGuardia = 'pendiente_activacion' | 'activo' | 'inactivo' | 'suspendido';

export interface GuardiaUbicacion {
  lat: number;
  lng: number;
  direccion: string | null;
  precisionM: number | null;
  bateriaPct: number | null;
  esSos: boolean;
  sosEstado: string | null;
  capturadoEn: Date;
}

export interface GuardiaRow {
  id: string;
  primerNombre: string;
  segundoNombre: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
  nombre: string;
  ci: string;
  usuario: string;
  telefono: string;
  fotoUrl: string | null;
  fechaNacimiento: Date;
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
  estado: string;
  estadoOperativo: EstadoOperativo;
  debeCambiarPassword: boolean;
  activadoEn: Date | null;
  createdAt: Date;
  ubicacion: GuardiaUbicacion | null;
  turnoActivo: boolean;
  turnoInicio: Date | null;
}

interface LastPoint {
  guardiaId: string;
  lat: number;
  lng: number;
  precisionM: unknown;
  bateriaPct: number | null;
  esSos: boolean;
  sosEstado: string | null;
  capturadoEn: Date;
}

async function ultimaPosicion(guardiaIds: string[]): Promise<Map<string, GuardiaUbicacion>> {
  if (guardiaIds.length === 0) return new Map();
  const rows = await db.$queryRaw<LastPoint[]>`
    select distinct on (guardia_id)
      guardia_id as "guardiaId", lat, lng,
      precision_m as "precisionM", bateria_pct as "bateriaPct",
      es_sos as "esSos", sos_estado as "sosEstado", capturado_en as "capturadoEn"
    from guardia_telemetria
    where guardia_id::text in (${Prisma.join(guardiaIds)})
    order by guardia_id, capturado_en desc`;
  const map = new Map<string, GuardiaUbicacion>();
  for (const row of rows) {
    map.set(row.guardiaId, {
      lat: row.lat,
      lng: row.lng,
      direccion: peekAddress(row.lat, row.lng) ?? null,
      precisionM: row.precisionM != null ? Number(row.precisionM) : null,
      bateriaPct: row.bateriaPct,
      esSos: row.esSos,
      sosEstado: row.sosEstado,
      capturadoEn: new Date(row.capturadoEn),
    });
  }
  return map;
}

async function turnosActivos(): Promise<Map<string, Date>> {
  const rows = await db.turno.findMany({
    where: { estado: 'en_servicio' },
    select: { guardiaId: true, horainicio: true },
  });
  return new Map(rows.map((r) => [r.guardiaId, r.horainicio]));
}

export async function listGuardias(
  includeUbicacion = true,
  filtros: { q?: string; epiCodigo?: string; estado?: string; estadoOperativo?: string } = {},
): Promise<GuardiaRow[]> {
  const where: any = {};
  if (filtros.epiCodigo) {
    const epi = await db.epi.findUnique({ where: { codigo: filtros.epiCodigo }, select: { id: true } });
    if (epi) where.epiId = epi.id;
    else where.epiId = '__none__';
  }
  if (filtros.estado) where.estado = filtros.estado;
  if (filtros.estadoOperativo) where.estadoOperativo = filtros.estadoOperativo;
  if (filtros.q) {
    const q = filtros.q.trim();
    if (q) {
      where.OR = [
        { primerNombre: { contains: q, mode: 'insensitive' } },
        { apellidoPaterno: { contains: q, mode: 'insensitive' } },
        { apellidoMaterno: { contains: q, mode: 'insensitive' } },
        { ci: { contains: q } },
        { usuario: { contains: q, mode: 'insensitive' } },
        { telefono: { contains: q } },
      ];
    }
  }
  const guardias = await db.guardia.findMany({
    where: Object.keys(where).length ? where : undefined,
    orderBy: { createdAt: 'desc' },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });

  const ids = guardias.map((g) => g.id);
  const [posiciones, activos] = await Promise.all([ultimaPosicion(ids), turnosActivos()]);

  return guardias.map((g) => ({
    id: g.id,
    primerNombre: g.primerNombre,
    segundoNombre: g.segundoNombre,
    apellidoPaterno: g.apellidoPaterno,
    apellidoMaterno: g.apellidoMaterno,
    nombre: nombreCompleto(g),
    ci: g.ci,
    usuario: g.usuario,
    telefono: g.telefono,
    fotoUrl: g.fotoUrl,
    fechaNacimiento: g.fechaNacimiento,
    epiId: g.epiId,
    epiCodigo: g.epi?.codigo ?? null,
    epiNombre: g.epi?.nombre ?? null,
    estado: g.estado,
    estadoOperativo: g.estadoOperativo,
    debeCambiarPassword: g.debeCambiarPassword,
    activadoEn: g.activadoEn,
    createdAt: g.createdAt,
    ubicacion: includeUbicacion ? (posiciones.get(g.id) ?? null) : null,
    turnoActivo: activos.has(g.id),
    turnoInicio: activos.get(g.id) ?? null,
  }));
}

export async function getGuardia(id: string): Promise<GuardiaRow & { hechosCount: number; turnosCount: number } | null> {
  const g = await db.guardia.findUnique({ where: { id }, include: { epi: { select: { codigo: true, nombre: true } } } });
  if (!g) return null;
  const posiciones = await ultimaPosicion([g.id]);
  const [activos, hechosCount, turnosCount] = await Promise.all([
    turnosActivos(),
    db.hecho.count({ where: { guardiaId: g.id } }),
    db.turno.count({ where: { guardiaId: g.id } }),
  ]);
  return {
    id: g.id,
    primerNombre: g.primerNombre,
    segundoNombre: g.segundoNombre,
    apellidoPaterno: g.apellidoPaterno,
    apellidoMaterno: g.apellidoMaterno,
    nombre: nombreCompleto(g),
    ci: g.ci,
    usuario: g.usuario,
    telefono: g.telefono,
    fotoUrl: g.fotoUrl,
    fechaNacimiento: g.fechaNacimiento,
    epiId: g.epiId,
    epiCodigo: g.epi?.codigo ?? null,
    epiNombre: g.epi?.nombre ?? null,
    estado: g.estado,
    estadoOperativo: g.estadoOperativo,
    debeCambiarPassword: g.debeCambiarPassword,
    activadoEn: g.activadoEn,
    createdAt: g.createdAt,
    ubicacion: posiciones.get(g.id) ?? null,
    turnoActivo: activos.has(g.id),
    turnoInicio: activos.get(g.id) ?? null,
    hechosCount,
    turnosCount,
  };
}

export async function updateGuardia(id: string, patch: {
  primerNombre?: string;
  segundoNombre?: string | null;
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  ci?: string;
  telefono?: string;
  fotoUrl?: string | null;
  epiId?: string | null;
  epiCodigo?: string | null;
}): Promise<GuardiaRow> {
  let epiId: string | null | undefined;
  if (patch.epiId !== undefined) {
    epiId = patch.epiId;
  } else if (patch.epiCodigo !== undefined) {
    epiId = (await db.epi.findUnique({ where: { codigo: patch.epiCodigo ?? undefined } }))?.id ?? null;
  }
  const data: Prisma.GuardiaUpdateInput = {
    ...(patch.primerNombre ? { primerNombre: patch.primerNombre } : {}),
    ...(patch.segundoNombre !== undefined ? { segundoNombre: patch.segundoNombre ?? null } : {}),
    ...(patch.apellidoPaterno ? { apellidoPaterno: patch.apellidoPaterno } : {}),
    ...(patch.apellidoMaterno ? { apellidoMaterno: patch.apellidoMaterno } : {}),
    ...(patch.ci ? { ci: patch.ci } : {}),
    ...(patch.telefono ? { telefono: patch.telefono } : {}),
    ...(patch.fotoUrl !== undefined ? { fotoUrl: patch.fotoUrl ?? null } : {}),
    ...(epiId !== undefined ? { epi: epiId ? { connect: { id: epiId } } : { disconnect: true } } : {}),
  };
  try {
    await db.guardia.update({ where: { id }, data });
  } catch {
    throw Errors.notFound('Guardía no encontrado.');
  }
  const guardia = await getGuardia(id);
  if (!guardia) throw Errors.notFound('Guardía no encontrado.');
  return guardia;
}

export async function setEstadoCuenta(id: string, estado: EstadoCuentaGuardia, actorId: string): Promise<GuardiaRow> {
  try {
    await db.guardia.update({ where: { id }, data: { estado } });
  } catch {
    throw Errors.notFound('Guardía no encontrado.');
  }
  const guardia = await getGuardia(id);
  if (!guardia) throw Errors.notFound('Guardía no encontrado.');
  await logAudit({ actorUserId: actorId, accion: `guardia_${estado}`, recurso: 'guardias', recursoId: id });
  publish(EVENTS.guardiaEstado, { guardiaId: id, estado, estadoOperativo: guardia.estadoOperativo });
  return guardia;
}

export async function setEstadoOperativo(id: string, estadoOperativo: EstadoOperativo, actorId: string): Promise<GuardiaRow> {
  const prev = await db.guardia.findUnique({ where: { id }, select: { estadoOperativo: true } });
  if (!prev) throw Errors.notFound('Guardía no encontrado.');
  try {
    await db.guardia.update({ where: { id }, data: { estadoOperativo } });
  } catch {
    throw Errors.notFound('Guardía no encontrado.');
  }
  // El SOS real vive en la última fila de guardia_telemetria (esSos/sosEstado),
  // no en guardia.estadoOperativo — pueden desincronizarse (ver reporte
  // 2026-09-13 §2.1), así que esto NO se condiciona a que `prev` haya sido
  // 'emergencia': se limpia cualquier ping SOS pendiente cada vez que el
  // nuevo estado no es 'emergencia', sin importar de dónde venía. Blindado
  // por test (guardias.service.test.ts).
  if (estadoOperativo !== 'emergencia') {
    const lastSos = await db.guardiaTelemetria.findFirst({
      where: { guardiaId: id, esSos: true },
      orderBy: { capturadoEn: 'desc' },
    });
    if (lastSos && lastSos.sosEstado !== 'atendido') {
      await db.guardiaTelemetria.update({
        where: { id: lastSos.id },
        data: { esSos: false, sosEstado: 'atendido', sosAtendidoPorId: actorId, sosAtendidoEn: new Date() },
      });
    }
  }
  const guardia = await getGuardia(id);
  if (!guardia) throw Errors.notFound('Guardía no encontrado.');
  await logAudit({ actorUserId: actorId, accion: `guardia_operativo_${estadoOperativo}`, recurso: 'guardias', recursoId: id });
  // Incluir esSos:false para que el handler optimista de MapasView limpie el SOS al instante
  // (antes el payload no tenía esSos y el frontend hacía payload.esSos ?? cur.hasSos -> se quedaba en true)
  const esSosResuelto = estadoOperativo !== 'emergencia' ? false : undefined;
  publish(EVENTS.guardiaUbicacion, {
    guardiaId: id,
    estadoOperativo,
    estado: guardia.estado,
    ...(esSosResuelto !== undefined ? { esSos: esSosResuelto, sosEstado: 'atendido' } : {}),
  });
  // Emitir guardia:estado siempre que se sale de emergencia para forzar reload completo
  // (antes solo si prev==='emergencia' && nuevo==='en_servicio', dejaba casos desincronizados sin refresh)
  if (estadoOperativo !== 'emergencia') {
    publish(EVENTS.guardiaEstado, { guardiaId: id, estadoOperativo, estado: guardia.estado, esSos: false });
    // También emitir sos:nuevo con esSos false para que GlobalSosBanner/notificaciones se enteren al instante
    publish(EVENTS.sosNuevo, { guardiaId: id, esSos: false, estadoOperativo });
  }
  return guardia;
}

export interface CreateGuardiaInput {
  primerNombre: string;
  segundoNombre?: string | null;
  apellidoPaterno: string;
  apellidoMaterno: string;
  ci: string;
  telefono: string;
  fechaNacimiento: Date;
  epiCodigo?: string | null;
  creadoPorId: string;
}

// Alta de guardia con credenciales autogeneradas (MASTER.md sección 13.2):
// usuario = primer nombre + últimos 2 dígitos de la CI; contraseña temporal
// aleatoria. La contraseña en texto plano se devuelve UNA sola vez; en BD
// solo queda el hash bcrypt y se fuerza el cambio en el primer login.
export async function createGuardia(input: CreateGuardiaInput): Promise<{ guardia: GuardiaRow; usuario: string; passwordTemporal: string }> {
  const ciDigits = input.ci.replace(/\D/g, '');
  const usuario = `${input.primerNombre.trim().toLowerCase()}${ciDigits.slice(-2)}`;
  const pwd = input.fechaNacimiento;
  const passwordTemporal = `${String(pwd.getDate()).padStart(2, '0')}${String(pwd.getMonth() + 1).padStart(2, '0')}${pwd.getFullYear()}`;
  const passwordHash = await PasswordService.hash(passwordTemporal);

  const epi = input.epiCodigo ? await db.epi.findUnique({ where: { codigo: input.epiCodigo } }) : null;

  try {
    const created = await db.guardia.create({
      data: {
        epiId: epi?.id ?? null,
        primerNombre: input.primerNombre,
        segundoNombre: input.segundoNombre ?? null,
        apellidoPaterno: input.apellidoPaterno,
        apellidoMaterno: input.apellidoMaterno,
        ci: input.ci,
        usuario,
        passwordHash,
        telefono: input.telefono,
        fechaNacimiento: input.fechaNacimiento,
        estado: 'pendiente_activacion',
        estadoOperativo: 'fuera_de_servicio',
        debeCambiarPassword: true,
        creadoPorId: input.creadoPorId,
      },
    });
    const guardia = await getGuardia(created.id);
    if (!guardia) throw Errors.notFound('Guardia creado pero no encontrado.');
    await logAudit({
      actorUserId: input.creadoPorId,
      accion: 'crear_guardia',
      recurso: 'guardias',
      recursoId: created.id,
      detalle: input,
    });
    publish(EVENTS.guardiaEstado, { guardiaId: created.id, estado: created.estado, estadoOperativo: created.estadoOperativo });
    return { guardia, usuario, passwordTemporal };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw Errors.conflict('El email, usuario o CI ya está registrado.');
    }
    throw error;
  }
}