import type { Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { env } from '@config/env';
import { COOKIES } from '@shared/cookies';
import type { AccessTokenClaims } from '@modules/auth/application/auth.types';
import { logger } from '@infra/logger';

/**
 * Canal real-time (Socket.io) montado sobre el MISMO servidor HTTP del API.
 *
 * · Autenticación: JWT de acceso en la cookie `gamc_access` (misma site que la
 *   web, SameSite=lax). El verifier lo inyecta el composition root para no
 *   acoplar esta capa al módulo auth.
 * · Rooms (F3): `dashboard` = usuarios web, para eventos GLOBALES
 *   (ubicación/estado de guardias, SOS, turnos: la disponibilidad y el SOS
 *   son visibles para todos los roles web). Los eventos TERRITORIALES
 *   (hechos, mandados, rutas) van solo a `epi:{id}` y a `epi:global`
 *   (Super Admin), con publishTerritorial. Un guardia entra solo a su sala
 *   `guardia:{id}`: ya no recibe el canal web. `user:{id}` permite
 *   cerrar sus conexiones al cambiarle la EPI o los permisos.
 * · Los eventos se publican con `publish(evento, payload)` desde cualquier
 *   capa (telemetría, cambio de estado, SOS...). Request/response HTTP sigue
 *   siendo la fuente de verdad; WS es el canal de empuje en vivo.
 */

export const ROOM_DASHBOARD = 'dashboard';
export const ROOM_EPI_GLOBAL = 'epi:global';
export const salaEpi = (epiId: string) => `epi:${epiId}`;

/** Salas territoriales del usuario web (las calcula el composition root). */
export type ResolverSalas = (claims: AccessTokenClaims) => Promise<string[]>;

export const EVENTS = {
  guardiaUbicacion: 'guardia:ubicacion',
  guardiaEstado: 'guardia:estado',
  sosNuevo: 'sos:nuevo',
  hechoActualizado: 'hecho:actualizado',
  patrullaAsignada: 'patrulla:asignada',
  patrullaCancelada: 'patrulla:cancelada',
  /** F2: cambio de estado de un guardia respecto a su ruta (incorporándose / en ruta / advertencia / alerta). */
  patrullaEstadoRuta: 'patrulla:estado_ruta',
  /** F2: alerta SOS atendida (con ids de las alertas). */
  sosAtendido: 'sos:atendido',
  /** F4: cambió el catálogo de puntos fijos (alta, edición, traslado, desactivación). */
  puntoFijoActualizado: 'punto_fijo:actualizado',
  /** F5: cambió una programación o uno de sus horarios (abierto, asignado, cerrado, cancelado). */
  programacionActualizada: 'programacion:actualizada',
  mandadoNuevo: 'mandado:nuevo',
  turnoIniciado: 'turno:iniciado',
  turnoFinalizado: 'turno:finalizado',
  telemetria: 'telemetria',
} as const;

let io: IOServer | null = null;

function readAccessCookie(headerCookie: string): string | undefined {
  const name = `${COOKIES.access}=`;
  for (const chunk of headerCookie.split(';')) {
    const part = chunk.trim();
    if (part.startsWith(name)) return decodeURIComponent(part.slice(name.length));
  }
  return undefined;
}

export function initRealtime(
  httpServer: HttpServer,
  verifyAccess: (token: string) => Promise<AccessTokenClaims>,
  resolverSalas: ResolverSalas = async () => [],
): IOServer {
  io = new IOServer(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    transports: ['websocket', 'polling'],
  });

  io.use((socket, next) => {
    const authHeader = (socket.handshake.headers.authorization as string | undefined) ?? (socket.handshake.auth as any)?.token;
    let access: string | undefined;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      access = authHeader.slice(7).trim();
    } else if ((socket.handshake.auth as any)?.token) {
      access = String((socket.handshake.auth as any).token);
    } else {
      access = readAccessCookie(socket.handshake.headers.cookie ?? '');
    }
    if (!access) return next(new Error('unauthorized'));
    verifyAccess(access)
      .then(async (claims) => {
        socket.data.principal = claims;
        if (claims.tipo === 'guardia') {
          // Solo su sala propia: el canal web (ubicación de todos, SOS,
          // hechos) no es para la app del guardia.
          socket.join(`guardia:${claims.sub}`);
        } else {
          socket.join([ROOM_DASHBOARD, `user:${claims.sub}`, ...(await resolverSalas(claims))]);
        }
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id, rol: socket.data.principal.rol }, 'socket conectado');
    socket.on('disconnect', () => logger.info({ socketId: socket.id }, 'socket desconectado'));
  });

  return io;
}

export function getIo(): IOServer {
  if (!io) throw new Error('Realtime no inicializado. Llama initRealtime() antes.');
  return io;
}

/** Evento GLOBAL para todos los usuarios web. */
export function publish(event: string, payload: unknown): void {
  getIo().to(ROOM_DASHBOARD).emit(event, payload);
}

/**
 * Evento TERRITORIAL: solo a la EPI del dato y a supervisión global. Un dato
 * sin EPI (pendiente de clasificar) solo llega a supervisión global.
 */
export function publishTerritorial(event: string, epiId: string | null | undefined, payload: unknown): void {
  getIo().to(epiId ? [ROOM_EPI_GLOBAL, salaEpi(epiId)] : ROOM_EPI_GLOBAL).emit(event, payload);
}

/** Cierra las conexiones de un usuario (p. ej. tras cambiarle la EPI): al reconectar recalcula sus salas. */
export function desconectarUsuario(userId: string): void {
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

export function isRealtimeReady(): boolean {
  return io !== null;
}