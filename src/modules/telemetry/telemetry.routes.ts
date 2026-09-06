import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate } from '@modules/auth/http/middlewares';
import { ingestTelemetry } from './telemetry.service.js';

const telemetrySchema = z.object({
  guardiaId: z.string().uuid(),
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

// Endpoint del MÓVIL (guardia). La web no lo llama: recibe lo mismo por
// Socket.io. Cualquier sesión válida puede reportar telemetría; el control
// de que el punto pertenezca a un turno válido lo hace la app móvil/GPS.
export function buildTelemetryRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = validate(telemetrySchema, req.body);
      const data = await ingestTelemetry(input);
      res.status(201).json({ data });
    }),
  );

  return router;
}