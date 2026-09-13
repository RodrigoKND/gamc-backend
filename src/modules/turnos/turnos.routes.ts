import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import {
  authenticate,
  authorize,
  requireGuardia,
  type AuthRequest,
} from '@modules/auth/http/middlewares';
import {
  cerrarTurno,
  iniciarTurno,
  listTurnosDeGuardia,
  recorridoDeTurno,
} from './turnos.service.js';

const iniciarSchema = z.object({
  selfieInicioUrl: z.string().url().max(500),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  horaInicio: z.coerce.date().optional(),
  patrullaId: z.string().uuid().optional().nullable(),
});

const cerrarSchema = z.object({
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
  horaFin: z.coerce.date().optional(),
});

// Turnos. Escritura y listado propio: exclusivo de la APP (guardia con Bearer).
// El recorrido (serie GPS) lo lee además la WEB con permiso `mapas:ver`.
export function buildTurnosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.post(
    '/',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(iniciarSchema, req.body);
      const turno = await iniciarTurno({ ...input, guardiaId: req.principal!.id });
      res.status(201).json({ data: turno });
    }),
  );

  router.patch(
    '/:id/cerrar',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      const body = validate(cerrarSchema, req.body ?? {});
      const turno = await cerrarTurno({
        turnoId: req.params.id!,
        guardiaId: req.principal!.id,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        ...(body.horaFin ? { horaFin: body.horaFin } : {}),
      });
      res.json({ data: turno });
    }),
  );

  router.get(
    '/',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      // `?guardia=me` es el único valor admitido para tokens de guardia.
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const turnos = await listTurnosDeGuardia(
        req.principal!.id,
        Number.isFinite(limit) ? limit : 50,
      );
      res.json({ data: turnos });
    }),
  );

  // Recorrido real del turno: web (mapas:ver) o el propio guardia dueño del turno.
  const recorridoGuard: RequestHandler = (req: AuthRequest, res, next) => {
    if (req.claims?.tipo === 'guardia') return next(); // el service valida que sea suyo
    return authorize('mapas', 'ver')(req, res, next);
  };

  router.get(
    '/:id/recorrido',
    recorridoGuard,
    asyncHandler(async (req: AuthRequest, res) => {
      const esGuardia = req.claims?.tipo === 'guardia';
      const result = await recorridoDeTurno(
        req.params.id!,
        esGuardia ? { guardiaId: req.principal!.id } : {},
      );
      res.json({ data: result });
    }),
  );

  return router;
}
