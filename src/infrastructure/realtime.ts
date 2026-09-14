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
 * · Rooms: `dashboard` (todos los roles con acceso a la web). El móvil puede
 *   unirse a su propia room `guardia:{id}` en el futuro.
 * · Los eventos se publican con `publish(evento, payload)` desde cualquier
 *   capa (telemetría, cambio de estado, SOS...). Request/response HTTP sigue
 *   siendo la fuente de verdad; WS es el canal de empuje en vivo.
 */

export const ROOM_DASHBOARD = 'dashboard';

export const EVENTS = {
  guardiaUbicacion: 'guardia:ubicacion',
  guardiaEstado: 'guardia:estado',
  sosNuevo: 'sos:nuevo',
  hechoActualizado: 'hecho:actualizado',
  patrullaAsignada: 'patrulla:asignada',
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
      .then((claims) => {
        socket.data.principal = claims;
        // Room por guardia para notificaciones dirigidas (app móvil)
        if (claims.tipo === 'guardia') socket.join(`guardia:${claims.sub}`);
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });

  io.on('connection', (socket) => {
    socket.join(ROOM_DASHBOARD);
    logger.info({ socketId: socket.id, rol: socket.data.principal.rol }, 'socket conectado');
    socket.on('disconnect', () => logger.info({ socketId: socket.id }, 'socket desconectado'));
  });

  return io;
}

export function getIo(): IOServer {
  if (!io) throw new Error('Realtime no inicializado. Llama initRealtime() antes.');
  return io;
}

export function publish(event: string, payload: unknown): void {
  getIo().to(ROOM_DASHBOARD).emit(event, payload);
}

export function isRealtimeReady(): boolean {
  return io !== null;
}