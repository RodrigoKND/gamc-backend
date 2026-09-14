import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { corsOptions } from '@config/cors';
import { errorHandler, notFoundHandler } from '@shared/errors';
import { logger } from '@infra/logger';
import { buildAuthRouter } from '@modules/auth/http/routes';
import { buildMobileAuthRouter } from '@modules/auth/http/mobile.routes';
import { buildGuardiasRouter } from '@modules/guardias/guardias.routes';
import { buildHechosRouter } from '@modules/hechos/hechos.routes';
import { buildMapasRouter } from '@modules/mapas/mapas.routes';
import { buildDashboardRouter } from '@modules/dashboard/dashboard.routes';
import { buildUsuariosRouter } from '@modules/usuarios/usuarios.routes';
import { buildAuditoriaRouter } from '@modules/auditoria/auditoria.routes';
import { buildTelemetryRouter } from '@modules/telemetry/telemetry.routes';
import { buildTurnosRouter } from '@modules/turnos/turnos.routes';
import { buildMandadosRouter } from '@modules/mandados/mandados.routes';
import { buildPatrullasRouter } from '@modules/patrullas/patrullas.routes';
import type { Container } from './composition.js';

// Ensamblaje del API HTTP (Express). Respuestas comprimidas con gzip,
// CORS solo con orígenes autorizados, errores en un formato único.

export function createApp(c: Container): express.Express {
  const app = express();

  app.set('trust proxy', '127.0.0.1');
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(compression({ threshold: 0 }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  const health = (_req: express.Request, res: express.Response): void => {
    res.json({ data: { ok: true, uptimeSeconds: Math.round(process.uptime()) } });
  };
  app.get('/health', health);
  app.get('/api/health', health);

  app.use('/api/auth', buildAuthRouter(c.authService, c.tokens));
  app.use('/api/mobile/auth', buildMobileAuthRouter(c.authService, c.tokens));
  app.use('/api/guardias', buildGuardiasRouter(c.tokens));
  app.use('/api/hechos', buildHechosRouter(c.tokens));
  app.use('/api/mapas', buildMapasRouter(c.tokens));
  app.use('/api/dashboard', buildDashboardRouter(c.tokens));
  app.use('/api/usuarios', buildUsuariosRouter(c.tokens));
  app.use('/api/auditoria', buildAuditoriaRouter(c.tokens));
  app.use('/api/telemetry', buildTelemetryRouter(c.tokens));
  // Endpoints de la app móvil de guardias (Bearer). Ver BD_UNIFICADA §1/§5.
  app.use('/api/turnos', buildTurnosRouter(c.tokens));
  app.use('/api/mandados', buildMandadosRouter(c.tokens));
  app.use('/api/patrullas', buildPatrullasRouter(c.tokens));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}