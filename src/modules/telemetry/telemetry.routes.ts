import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, Errors } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, type AuthRequest } from '@modules/auth/http/middlewares';
import { ingestTelemetry } from './telemetry.service.js';

const telemetrySchema = z.object({
  guardiaId: z.string().uuid().optional(),
  turnoId: z.string().uuid().optional().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  precisionM: z.number().nonnegative().optional().nullable(),
  velocidadMps: z.number().nonnegative().optional().nullable(),
  bateriaPct: z.number().int().min(0).max(100).optional().nullable(),
  esSos: z.boolean().optional(),
  sosEstado: z.string().optional().nullable(),
  capturadoEn: z.coerce.date(),
});

// Endpoint del MÓVIL (guardia). Acepta cookie (web/dev) o Authorization: Bearer
// (app). Para un token de guardia el `guardiaId` SIEMPRE sale del JWT: un
// guardia solo reporta su propia posición. El SOS es esta misma fila con
// `esSos: true` (BD_UNIFICADA §2.2, se unificó api/sos.ts).
export function buildTelemetryRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  // Estado SOS actual del guardia autenticado (para que el botón SOS sepa si ya fue atendido)
  router.get(
    '/estado',
    asyncHandler(async (req: AuthRequest, res) => {
      const guardiaId = req.principal!.id;
      const { db } = await import('@infra/database');
      const last: any = await db.guardiaTelemetria.findFirst({
        where: { guardiaId },
        orderBy: { capturadoEn: 'desc' },
        select: { esSos: true, sosEstado: true, capturadoEn: true },
      });
      const guardia: any = await db.guardia.findUnique({
        where: { id: guardiaId },
        select: { estadoOperativo: true },
      });
      res.json({ data: { esSos: last?.esSos ?? false, sosEstado: last?.sosEstado ?? null, estadoOperativo: guardia?.estadoOperativo ?? null, capturadoEn: last?.capturadoEn ?? null } });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(telemetrySchema, req.body);
      const guardiaId =
        req.claims?.tipo === 'guardia' ? req.principal!.id : input.guardiaId;
      if (!guardiaId) throw Errors.validation('Falta guardiaId.');
      const data = await ingestTelemetry({ ...input, guardiaId });
      res.status(201).json({ data });
    }),
  );

  return router;
}
