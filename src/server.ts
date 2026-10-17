import http from 'node:http';
import { logger } from '@infra/logger';
import { env } from '@config/env';
import { db } from '@infra/database';
import { initRealtime, ROOM_EPI_GLOBAL, salaEpi } from '@infra/realtime';
import { createApp } from './app.js';
import { buildContainer } from './composition.js';
import { pasadaPlanificador } from '@modules/programacion/planificador';
import { PLANIFICADOR_INTERVALO_MS } from '@modules/programacion/config';

const container = buildContainer();

const app = createApp(container);
const server = http.createServer(app);

// WebSockets sobre el MISMO puerto del API (reutiliza el server HTTP).
// Salas territoriales (F3): Super Admin recibe todas las EPIs; el resto, la
// suya si está activa. Sin EPI válida no recibe eventos territoriales.
initRealtime(server, container.tokens.verifyAccessToken.bind(container.tokens), async (claims) => {
  if (claims.rol === 'super_admin') return [ROOM_EPI_GLOBAL];
  const user = await db.user.findUnique({ where: { id: claims.sub }, select: { epi: { select: { id: true, activo: true } } } });
  return user?.epi?.activo ? [salaEpi(user.epi.id)] : [];
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'GAMC API listo');
});

// Planificador (F5, incluye el cierre de asignaciones vencidas de F2): cada
// minuto cierra lo que terminó, abre los horarios programados que empiezan
// en 15 min e inicia los que llegaron a su hora. Corre en el servidor, haya o
// no operadores conectados, y al arrancar recupera los horarios en curso.
// DESACTIVAR_VENCIMIENTO_RUTAS=1 lo apaga en esta instancia (p. ej. una
// segunda); dos instancias igual no duplican nada (índices únicos y locks).
// Para pausar SOLO la apertura de horarios está el interruptor de la web.
let vencimiento: NodeJS.Timeout | null = null;
if (process.env.DESACTIVAR_VENCIMIENTO_RUTAS !== '1') {
  let corriendo = false;
  const tick = () => {
    if (corriendo) return; // una pasada lenta no se solapa con la siguiente
    corriendo = true;
    pasadaPlanificador()
      .then((r) => {
        if (r.abiertas + r.iniciadas + r.cerradas + r.perdidas + r.omitidas + r.fueraDePlazo > 0) logger.info(r, 'Planificador: pasada con cambios');
        if (r.errores > 0) logger.warn(r, 'Planificador: pasada con errores');
      })
      .catch((err) => logger.error({ err }, 'Falló la pasada del planificador'))
      .finally(() => {
        corriendo = false;
      });
  };
  vencimiento = setInterval(tick, PLANIFICADOR_INTERVALO_MS);
  vencimiento.unref();
  tick();
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (vencimiento) clearInterval(vencimiento);
  // logger.info({ signal }, 'Apagando...');
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
  // Forzado si hay conexiones colgadas.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));