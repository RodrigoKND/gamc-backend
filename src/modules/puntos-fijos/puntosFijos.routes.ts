import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { alcanceOVacio, jurisdiccionDe } from '@modules/mapas/jurisdiccion';
import { actualizarPuntoFijo, crearPuntoFijo, historialPuntoFijo, listarPuntosFijos } from './puntosFijos.service.js';

// Catálogo de puntos fijos (F4). Leer: usuario web con mapas.ver, segmentado
// por EPI (solo los de su EPI; el Super Admin, todos); escribir: permiso
// `puntos_fijos`, que el servicio valida junto con la jurisdicción.

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const crearSchema = z.object({
  nombre: z.string().trim().min(2).max(80),
  descripcion: z.string().trim().max(300).optional().nullable(),
  lat,
  lng,
  capacidad: z.number().int().min(1).max(50),
  padreId: z.string().uuid().optional().nullable(),
  epiCodigo: z.string().trim().min(2).max(40).optional().nullable(),
  coordenadasAproximadas: z.boolean().optional(),
});

const actualizarSchema = z.object({
  nombre: z.string().trim().min(2).max(80).optional(),
  descripcion: z.string().trim().max(300).optional().nullable(),
  lat: lat.optional(),
  lng: lng.optional(),
  capacidad: z.number().int().min(1).max(50).optional(),
  activo: z.boolean().optional(),
  coordenadasAproximadas: z.boolean().optional(),
  epiCodigo: z.string().trim().min(2).max(40).optional().nullable(),
  politicaOcupados: z.enum(['trasladar', 'retirar']).optional(),
  motivo: z.string().trim().max(300).optional().nullable(),
});

function actorDe(req: AuthRequest) {
  const p = req.principal!;
  return { id: p.id, role: p.role, permissions: p.permissions as Record<string, { ver?: boolean; crear?: boolean; editar?: boolean; eliminar?: boolean }> };
}

export function buildPuntosFijosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      // Una cuenta sin EPI recibe la lista vacía (alcance vacío, nunca global).
      const alcance = await alcanceOVacio(req.principal!);
      res.json({
        data: await listarPuntosFijos(alcance, { incluirInactivos: req.query.incluirInactivos === '1', epiCodigo: str(req.query.epi) }),
      });
    }),
  );

  router.get(
    '/:id/historial',
    authorize('puntos_fijos', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await historialPuntoFijo(req.params.id!, await alcanceOVacio(req.principal!)) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearSchema, req.body);
      const punto = await crearPuntoFijo(input, actorDe(req), await jurisdiccionDe(req.principal!));
      res.status(201).json({ data: punto });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req: AuthRequest, res) => {
      const patch = validate(actualizarSchema, req.body);
      res.json({ data: await actualizarPuntoFijo(req.params.id!, patch, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  return router;
}
