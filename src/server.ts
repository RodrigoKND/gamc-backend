import http from 'node:http';
import { logger } from '@infra/logger';
import { env } from '@config/env';
import { db } from '@infra/database';
import { initRealtime } from '@infra/realtime';
import { createApp } from './app.js';
import { buildContainer } from './composition.js';

const container = buildContainer();

const app = createApp(container);
const server = http.createServer(app);

// WebSockets sobre el MISMO puerto del API (reutiliza el server HTTP).
initRealtime(server, container.tokens.verifyAccessToken.bind(container.tokens));

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'GAMC API listo');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
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