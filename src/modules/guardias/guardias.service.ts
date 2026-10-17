import { Prisma } from '@prisma/client';
import { db } from '@infra/database';
import { Errors } from '@shared/errors';
import { nombreCompleto } from '@shared/names';
import { PasswordService } from '@modules/auth/application/password.service';
import { EVENTS, publish } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { peekAddress } from '@modules/mapas/geocoding.service.js';
import { atenderTodasLasAlertas } from './sos.service.js';
import { epiDeAlcance, type Alcance } from '@modules/mapas/jurisdiccion';

/** Edad máxima (min) de la última posición para considerar "reciente" la EPI actual. */
export const EPI_ACTUAL_RECIENTE_MIN = 10;

/**
 * EPI en la que está el guardia AHORA (F3), por su última posición
 * válida. `frescura`: reciente (≤ 10 min) | antigua | sin_dato. La EPI de
 * la cuenta (epiId/epiCodigo) queda como dato legado.
 */
export interface EpiActual {
  epiId: string | null;
  epiCodigo: string | null;
  epiNombre: string | null;
  /** asignada | ambigua | fuera_cobertura */
  estado: string;
  capturadoEn: Date;
  /** Desde cuándo está en esta EPI. */
  desde: Date;
  frescura: 'reciente' | 'antigua';
}

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
  /** F3: null = el guardia nunca reportó GPS (EPI actual desconocida). */
  epiActual: EpiActual | null;
  /** F3: hechos reportados por el guardia DENTRO del alcance de quien consulta. */
  hechosCount: number;
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

async function episActuales(guardiaIds: string[]): Promise<Map<string, EpiActual>> {
  if (guardiaIds.length === 0) return new Map();
  const rows = await db.guardiaUbicacionActual.findMany({
    where: { guardiaId: { in: guardiaIds } },
    include: { epi: { select: { codigo: true, nombre: true } } },
  });
  const limite = Date.now() - EPI_ACTUAL_RECIENTE_MIN * 60_000;
  return new Map(
    rows.map((r) => [
      r.guardiaId,
      {
        epiId: r.epiId,
        epiCodigo: r.epi?.codigo ?? null,
        epiNombre: r.epi?.nombre ?? null,
        estado: r.epiEstado,
        capturadoEn: r.capturadoEn,
        desde: r.epiDesde,
        frescura: r.capturadoEn.getTime() >= limite ? 'reciente' : 'antigua',
      },
    ]),
  );
}

/** Hechos por guardia dentro del alcance (antes la web los contaba sobre una página de 200). */
async function hechosPorGuardia(guardiaIds: string[], alcance: Alcance | null): Promise<Map<string, number>> {
  if (guardiaIds.length === 0) return new Map();
  const epi = alcance ? epiDeAlcance(alcance) : undefined;
  const rows = await db.hecho.groupBy({
    by: ['guardiaId'],
    where: { guardiaId: { in: guardiaIds }, ...(epi ? { epiId: epi } : {}) },
    _count: { id: true },
  });
  return new Map(rows.map((r) => [r.guardiaId, r._count.id]));
}

async function turnosActivos(): Promise<Map<string, Date>> {
  const rows = await db.turno.findMany({
    where: { estado: 'en_servicio' },
    select: { guardiaId: true, horainicio: true },
  });
  return new Map(rows.map((r) => [r.guardiaId, r.horainicio]));
}

// La lista de guardias es GLOBAL para todos los roles web (F3): un
// operador puede elegir personal de cualquier ubicación. Lo territorial (el
// conteo de hechos) sí respeta el alcance de quien consulta.
export async function listGuardias(
  includeUbicacion = true,
  filtros: { q?: string; epiCodigo?: string; epiActual?: string; estado?: string; estadoOperativo?: string; excluirInactivos?: boolean; page?: number; pageSize?: number } = {},
  alcance: Alcance | null = null,
): Promise<{ rows: GuardiaRow[]; total: number }> {
  const where: any = {};
  if (filtros.epiCodigo) {
    // Código desconocido → lista vacía, no un UUID inventado: antes se
    // filtraba por '__none__' y Postgres respondía 500 (no es un uuid).
    const epi = await db.epi.findUnique({ where: { codigo: filtros.epiCodigo }, select: { id: true } });
    if (!epi) return { rows: [], total: 0 };
    where.epiId = epi.id;
  }
  // Filtro por EPI ACTUAL (donde está hoy): código de EPI, o 'sin_dato'
  // (nunca reportó GPS) / 'fuera_cobertura'.
  if (filtros.epiActual === 'sin_dato') where.ubicacionActual = { is: null };
  else if (filtros.epiActual === 'fuera_cobertura') where.ubicacionActual = { is: { epiId: null } };
  else if (filtros.epiActual) {
    const epi = await db.epi.findUnique({ where: { codigo: filtros.epiActual }, select: { id: true } });
    if (!epi) return { rows: [], total: 0 };
    where.ubicacionActual = { is: { epiId: epi.id } };
  }
  if (filtros.estado) where.estado = filtros.estado;
  // La tabla principal de /guardias esconde a los dados de baja (cuenta
  // 'inactivo') — antes esa exclusión vivía SOLO client-side
  // (isDadoDeBaja en features/guardias/types.ts) filtrando sobre la
  // lista completa; ahora que esa vista pide página por página al
  // backend, la regla tiene que aplicarse acá para no mostrarlos.
  else if (filtros.excluirInactivos) where.estado = { not: 'inactivo' };
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
  const whereClause = Object.keys(where).length ? where : undefined;

  // Paginación (page/pageSize) opcional — sin ellos se comporta como
  // antes (trae todo), porque getGuardMarkers/GlobalSosBanner/el filtro
  // por estado del Dashboard necesitan la lista completa para poder
  // filtrar en memoria. Solo la tabla de /guardias pide página por página.
  const pageSize = filtros.pageSize ? Math.min(Math.max(filtros.pageSize, 1), 500) : undefined;
  const page = pageSize ? Math.max(filtros.page ?? 1, 1) : undefined;

  // orderBy por estadoOperativo aprovecha el orden real del enum en
  // Postgres (fuera_de_servicio < en_servicio < emergencia, ver
  // schema.prisma) — 'desc' pone emergencia primero, luego en_servicio,
  // luego fuera_de_servicio. Pedido explícito: "los de servicio van
  // primero" — antes solo ordenaba por fecha de creación.
  const [guardias, total] = await Promise.all([
    db.guardia.findMany({
      where: whereClause,
      orderBy: [{ estadoOperativo: 'desc' }, { createdAt: 'desc' }],
      include: { epi: { select: { codigo: true, nombre: true } } },
      ...(pageSize ? { take: pageSize, skip: (page! - 1) * pageSize } : {}),
    }),
    db.guardia.count({ where: whereClause }),
  ]);

  const ids = guardias.map((g) => g.id);
  const [posiciones, activos, actuales, conteos] = await Promise.all([
    ultimaPosicion(ids),
    turnosActivos(),
    episActuales(ids),
    hechosPorGuardia(ids, alcance),
  ]);

  const rows = guardias.map((g) => ({
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
    epiActual: actuales.get(g.id) ?? null,
    hechosCount: conteos.get(g.id) ?? 0,
  }));
  return { rows, total };
}

export async function getGuardia(id: string, alcance: Alcance | null = null): Promise<GuardiaRow & { turnosCount: number } | null> {
  const g = await db.guardia.findUnique({ where: { id }, include: { epi: { select: { codigo: true, nombre: true } } } });
  if (!g) return null;
  const posiciones = await ultimaPosicion([g.id]);
  const [activos, conteos, turnosCount, actuales] = await Promise.all([
    turnosActivos(),
    hechosPorGuardia([g.id], alcance),
    db.turno.count({ where: { guardiaId: g.id } }),
    episActuales([g.id]),
  ]);
  const hechosCount = conteos.get(g.id) ?? 0;
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
    epiActual: actuales.get(g.id) ?? null,
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
  // Compatibilidad: salir de 'emergencia' por este endpoint atiende TODAS las
  // alertas abiertas (antes solo la última, y otras quedaban pendientes). La
  // atención normal es POST /guardias/:id/sos/atender (sos.service.ts), que
  // atiende exactamente las alertas vistas y deriva el estado del turno real.
  // El registro conserva es_sos = true y pasa a 'atendido' (historial).
  try {
    await db.$transaction(async (tx) => {
      await tx.guardia.update({ where: { id }, data: { estadoOperativo } });
      if (estadoOperativo !== 'emergencia') await atenderTodasLasAlertas(tx, id, actorId);
    });
  } catch {
    throw Errors.notFound('Guardía no encontrado.');
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
  // FIX 2026-09-15 + SOS: publicar guardiaEstado siempre para que Mapas recargue completo
  // sin importar la transición (antes solo emergencia->en_servicio). Si se sale de emergencia
  // también emitir sos:nuevo con esSos false para banner/notificaciones.
  publish(EVENTS.guardiaEstado, {
    guardiaId: id,
    estadoOperativo,
    estado: guardia.estado,
    ...(esSosResuelto !== undefined ? { esSos: false } : {}),
  });
  if (estadoOperativo !== 'emergencia') {
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