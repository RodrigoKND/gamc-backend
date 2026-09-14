import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import {
  authenticate,
  authorize,
  authorizeWebOrGuardia,
  requireGuardia,
  type AuthRequest,
} from '@modules/auth/http/middlewares';
import {
  changeHechoEstado,
  crearHechoMovil,
  listHechos,
  listHechosDeGuardia,
  listTiposHecho,
} from './hechos.service.js';

const crearMovilSchema = z.object({
  tipoHechoId: z.string().uuid().optional().nullable(),
  tipoCodigo: z.string().trim().min(2).max(60).optional().nullable(),
  descripcion: z.string().trim().min(3).max(2000),
  nivelRiesgo: z.enum(['bajo', 'medio', 'alto', 'muy_alto']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  ocurridoEn: z.coerce.date().optional(),
  direccion: z.string().trim().max(300).optional().nullable(),
  turnoId: z.string().uuid().optional().nullable(),
  evidencias: z
    .array(z.object({ url: z.string().url().max(500), tipo: z.enum(['foto', 'video']).optional() }))
    .max(12)
    .optional(),
});

export function buildHechosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  // Catálogo del formulario — lo consumen la web y la app (BD_UNIFICADA §1).
  router.get(
    '/tipos',
    authorizeWebOrGuardia('hechos', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listTiposHecho() });
    }),
  );

  // Alta de hecho desde el MÓVIL.
  router.post(
    '/',
    requireGuardia,
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearMovilSchema, req.body);
      const hecho = await crearHechoMovil({ ...input, guardiaId: req.principal!.id });
      res.status(201).json({ data: hecho });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req: AuthRequest, res, next) => {
      // Guardia (Bearer): solo su propio historial.
      if (req.claims?.tipo === 'guardia') {
        res.json({ data: await listHechosDeGuardia(req.principal!.id) });
        return;
      }
      // Usuario web: filtros + permiso `hechos:ver`.
      authorize('hechos', 'ver')(req, res, () => {
        const q = typeof req.query.q === 'string' ? req.query.q : undefined;
        const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : undefined;
        const estado = typeof req.query.estado === 'string' ? req.query.estado : undefined;
        const epiId = typeof req.query.epiId === 'string' ? req.query.epiId : typeof req.query.epi === 'string' ? req.query.epi : undefined;
        const desde = typeof req.query.desde === 'string' ? req.query.desde : undefined;
        const hasta = typeof req.query.hasta === 'string' ? req.query.hasta : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const offset = req.query.offset ? Number(req.query.offset) : undefined;
        listHechos({ q, tipo, estado, epiId, desde, hasta, limit, offset })
          .then((data) => res.json({ data }))
          .catch(next);
      });
    }),
  );

  router.patch(
    '/:id/estado',
    authorize('hechos', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { estado } = validate(
        z.object({ estado: z.enum(['reportado', 'en_revision', 'cerrado']) }),
        req.body,
      );
      const hecho = await changeHechoEstado(req.params.id!, estado, req.principal!.id);
      res.json({ data: hecho });
    }),
  );

  return router;
}
