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
import { alcanceDe } from '@modules/mapas/jurisdiccion';
import {
  changeHechoEstado,
  clasificarHechoManual,
  countHechos,
  crearHechoMovil,
  exportarHechos,
  getHecho,
  listHechos,
  listHechosDeGuardia,
  listTiposHecho,
  type HechoFiltros,
} from './hechos.service.js';
import { Errors } from '@shared/errors';

function filtrosDe(query: Record<string, unknown>): HechoFiltros {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    q: str(query.q),
    tipo: str(query.tipo),
    estado: str(query.estado),
    epiId: str(query.epiId) ?? str(query.epi),
    nivelRiesgo: str(query.nivelRiesgo),
    desde: str(query.desde),
    hasta: str(query.hasta),
    clasificacion: str(query.clasificacion),
  };
}

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
      // Usuario web: filtros + permiso `hechos:ver`, dentro de su alcance
      // territorial (F3): Operador/Admin ven los hechos de SU EPI.
      authorize('hechos', 'ver')(req, res, () => {
        const filtros = filtrosDe(req.query);
        alcanceDe(req.principal!)
          .then(async (alcance) => {
            // page/pageSize (opcional, aditivo a limit/offset de siempre):
            // cuando viene, también se pide el total real.
            const page = req.query.page ? Number(req.query.page) : undefined;
            if (page) {
              const pageSize = Math.min(Math.max(req.query.pageSize ? Number(req.query.pageSize) : 20, 1), 100);
              const offset = Math.max(page - 1, 0) * pageSize;
              const [data, total] = await Promise.all([listHechos(alcance, { ...filtros, limit: pageSize, offset }), countHechos(alcance, filtros)]);
              res.json({ data, meta: { total, page, pageSize } });
              return;
            }
            const limit = req.query.limit ? Number(req.query.limit) : undefined;
            const offset = req.query.offset ? Number(req.query.offset) : undefined;
            res.json({ data: await listHechos(alcance, { ...filtros, limit, offset }) });
          })
          .catch(next);
      });
    }),
  );

  // Exportación completa (todas las páginas) dentro del alcance.
  router.get(
    '/exportar',
    authorize('hechos', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const r = await exportarHechos(await alcanceDe(req.principal!), filtrosDe(req.query));
      res.json({ data: r.rows, meta: { total: r.total, truncado: r.truncado } });
    }),
  );

  router.get(
    '/:id',
    authorize('hechos', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await getHecho(req.params.id!, await alcanceDe(req.principal!)) });
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
      const hecho = await changeHechoEstado(req.params.id!, estado, req.principal!.id, await alcanceDe(req.principal!));
      res.json({ data: hecho });
    }),
  );

  // Bandeja de supervisión: solo alcance global decide la EPI de un hecho.
  router.patch(
    '/:id/epi',
    authorize('hechos', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { epiCodigo } = validate(z.object({ epiCodigo: z.string().trim().min(2).max(40) }), req.body);
      if ((await alcanceDe(req.principal!)).tipo !== 'global') {
        throw Errors.forbidden('Solo la supervisión global (Super Administrador) clasifica hechos.');
      }
      res.json({ data: await clasificarHechoManual(req.params.id!, epiCodigo, req.principal!.id) });
    }),
  );

  return router;
}
