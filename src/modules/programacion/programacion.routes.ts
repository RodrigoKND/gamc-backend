import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { alcanceDe, alcanceOVacio, jurisdiccionDe } from '@modules/mapas/jurisdiccion';
import { DIAS_SEMANA, DURACION_MAX_MIN, DURACION_MIN_MIN, VENTANAS_MAX } from './config.js';
import { intentarAhora } from './automatica.js';
import {
  actualizarProgramacion,
  agenda,
  avisosPendientes,
  cambiarPlanificador,
  crearProgramacion,
  eliminarProgramacion,
  intentosAutomaticos,
  estadoPlanificador,
  listarProgramaciones,
  reanudarAutomatica,
  type ActorProgramacion,
} from './programacion.service.js';

// Programación de rutas (F5). Leer: permiso `programacion_rutas.ver`,
// segmentado por EPI (el Super Admin ve todas). Escribir: el servicio valida
// `programacion_rutas` (crear/editar/eliminar) junto con la jurisdicción.
// Asignar guardias a un horario abierto usa el motor de siempre:
// POST /api/mapas/ejecuciones con `ejecucionId`.

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

const ventanaSchema = z.object({
  id: z.string().uuid().optional(),
  dias: z
    .array(z.number().int().min(DIAS_SEMANA[0]).max(DIAS_SEMANA[6]))
    .min(1, 'Elige al menos un día')
    .max(7),
  horaInicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM'),
  duracionMin: z.number().int().min(DURACION_MIN_MIN).max(DURACION_MAX_MIN),
  cupo: z.number().int().min(1).max(50),
});

// F6: modo de asignación. El radio lo maneja el sistema.
const asignacionSchema = {
  modo: z.enum(['manual', 'automatica']).optional(),
};

const crearSchema = z.object({
  nombre: z.string().trim().min(2).max(120).optional().nullable(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  rutaPlantillaId: z.string().uuid().optional(),
  puntoFijoId: z.string().uuid().optional(),
  origen: z.enum(['manual', 'prueba']).optional(),
  ...asignacionSchema,
  ventanas: z.array(ventanaSchema).min(1).max(VENTANAS_MAX),
});

const editarSchema = z.object({
  nombre: z.string().trim().min(2).max(120).optional(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  estado: z.enum(['activa', 'pausada']).optional(),
  ...asignacionSchema,
  ventanas: z.array(ventanaSchema).min(1).max(VENTANAS_MAX).optional(),
});

const planificadorSchema = z.object({
  habilitado: z.boolean(),
  motivo: z.string().trim().max(300).optional().nullable(),
});

function actorDe(req: AuthRequest): ActorProgramacion {
  const p = req.principal!;
  return { id: p.id, role: p.role, permissions: p.permissions as ActorProgramacion['permissions'] };
}

export function buildProgramacionRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

  router.get(
    '/',
    authorize('programacion_rutas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await listarProgramaciones(await alcanceDe(req.principal!), { incluirArchivadas: req.query.incluirArchivadas === '1' }) });
    }),
  );

  // Agenda: horarios entre dos fechas locales (por defecto hoy y mañana).
  router.get(
    '/agenda',
    authorize('programacion_rutas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { desde, hasta } = validate(z.object({ desde: fechaIso.optional(), hasta: fechaIso.optional() }), { desde: str(req.query.desde), hasta: str(req.query.hasta) });
      res.json({ data: await agenda(await alcanceDe(req.principal!), { desde, hasta }) });
    }),
  );

  // Avisos de la campana: horarios abiertos con cupo sin cubrir. Una cuenta
  // sin EPI recibe la lista vacía (alcance vacío, nunca global).
  router.get(
    '/pendientes',
    authorize('programacion_rutas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await avisosPendientes(await alcanceOVacio(req.principal!)) });
    }),
  );

  // F6: a quién eligió o descartó la asignación automática en un horario, y por qué.
  router.get(
    '/horarios/:ejecucionId/automatica',
    authorize('programacion_rutas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { ejecucionId } = validate(z.object({ ejecucionId: z.string().uuid() }), req.params);
      res.json({ data: await intentosAutomaticos(ejecucionId, await alcanceDe(req.principal!)) });
    }),
  );

  // F6: el operador terminó de elegir a mano: la automática sigue al momento con lo que falte.
  router.post(
    '/horarios/:ejecucionId/reanudar',
    asyncHandler(async (req: AuthRequest, res) => {
      const { ejecucionId } = validate(z.object({ ejecucionId: z.string().uuid() }), req.params);
      const r = await reanudarAutomatica(ejecucionId, actorDe(req), await jurisdiccionDe(req.principal!));
      void intentarAhora(ejecucionId);
      res.json({ data: r });
    }),
  );

  router.get(
    '/planificador',
    authorize('programacion_rutas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await estadoPlanificador(req.principal!.role === 'super_admin') });
    }),
  );

  // Interruptor: deja de abrir horarios nuevos (los cierres siguen). Solo Super Admin.
  router.patch(
    '/planificador',
    asyncHandler(async (req: AuthRequest, res) => {
      const body = validate(planificadorSchema, req.body);
      res.json({ data: await cambiarPlanificador(body.habilitado, body.motivo ?? null, actorDe(req)) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearSchema, req.body);
      res.status(201).json({ data: await crearProgramacion(input, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req: AuthRequest, res) => {
      const patch = validate(editarSchema, req.body);
      res.json({ data: await actualizarProgramacion(req.params.id!, patch, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  // Eliminar (lógico): cancela el horario abierto y conserva el historial.
  router.delete(
    '/:id',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await eliminarProgramacion(req.params.id!, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  return router;
}
