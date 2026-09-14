import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { recorridoQuery } from '@modules/turnos/turnos.service';
import {
  asignarPatrulla,
  crearRutaPlantilla,
  heatmap,
  patrullasVigentes,
  recalcularZonasCriticas,
  rutasPlantilla,
  ubicacionesActuales,
  zonasCriticas,
} from './mapas.service.js';

const asignarSchema = z.object({
  guardiaId: z.string().uuid(),
  rutaPlantillaId: z.string().uuid().optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  nombre: z.string().trim().max(120).optional().nullable(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  poligonoGeojson: z.unknown().optional().nullable(),
});

export function buildMapasRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/ubicaciones',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await ubicacionesActuales() });
    }),
  );

  router.get(
    '/patrullas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await patrullasVigentes() });
    }),
  );

  router.get(
    '/rutas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await rutasPlantilla() });
    }),
  );

  router.get(
    '/zonas',
    authorize('mapas', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await zonasCriticas() });
    }),
  );

  router.get(
    '/heatmap',
    authorize('mapas', 'ver'),
    asyncHandler(async (req, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      res.json({
        data: await heatmap({ desde: str(req.query.desde), hasta: str(req.query.hasta), epiId: str(req.query.epiId) }),
      });
    }),
  );

  router.post(
    '/zonas/recalcular',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await recalcularZonasCriticas(req.principal!.id) });
    }),
  );

  router.post(
    '/rutas',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const schema = z.object({
        nombre: z.string().trim().min(2).max(120),
        descripcion: z.string().trim().max(500).optional().nullable(),
        epiId: z.string().trim().max(80).optional().nullable(),
        epiCodigo: z.string().trim().max(40).optional().nullable(),
        trazado: z.unknown().optional().nullable(),
      });
      const input = validate(schema, req.body);
      let epiId: string | null = null;
      if (input.epiId) {
        // Si es uuid lo usamos directo, si es codigo lo resolvemos
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.epiId);
        if (isUuid) epiId = input.epiId;
        else {
          const { db } = await import('@infra/database.js');
          const epi = await db.epi.findUnique({ where: { codigo: input.epiId } });
          epiId = epi?.id ?? null;
        }
      } else if (input.epiCodigo) {
        const { db } = await import('@infra/database.js');
        const epi = await db.epi.findUnique({ where: { codigo: input.epiCodigo } });
        epiId = epi?.id ?? null;
      }
      const row = await crearRutaPlantilla({
        nombre: input.nombre,
        descripcion: input.descripcion ?? null,
        epiId,
        trazado: input.trazado as Prisma.InputJsonValue | null | undefined,
        creadoPorId: req.principal!.id,
      });
      res.status(201).json({ data: row });
    }),
  );

  // Recorrido real: por turno, o por guardia + ventana temporal.
  router.get(
    '/recorrido',
    authorize('mapas', 'ver'),
    asyncHandler(async (req, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      const data = await recorridoQuery({
        turnoId: str(req.query.turnoId),
        guardiaId: str(req.query.guardiaId),
        desde: str(req.query.desde),
        hasta: str(req.query.hasta),
      });
      res.json({ data });
    }),
  );

  router.post(
    '/patrullas',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(asignarSchema, req.body);
      const patrulla = await asignarPatrulla({
        ...input,
        poligonoGeojson: input.poligonoGeojson as Prisma.InputJsonValue | null | undefined,
        asignadoPorId: req.principal!.id,
      });
      res.status(201).json({ data: patrulla });
    }),
  );

  return router;
}
