import { Router } from 'express';
import { z } from 'zod';
import { AppError, Errors, asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { recortarRecorrido, recorridoQuery, ventanasAutorizadas } from '@modules/turnos/turnos.service';
import { MODALIDADES, TIPOS_RUTA } from '@modules/ejecuciones/config';
import {
  asignarEjecucion,
  cancelarEjecucion,
  previsualizarAsignacion,
  retirarGuardia,
  type Actor,
  type AsignarInput,
} from '@modules/ejecuciones/ejecuciones.service';
import { intentarAhora } from '@modules/programacion/automatica';
import { db } from '@infra/database';
import {
  actualizarRutaPlantilla,
  archivarRutaPlantilla,
  crearRutaPlantilla,
  geocodificarPuntos,
  heatmap,
  patrullasVigentes,
  recalcularZonasCriticas,
  rutasPlantilla,
  ubicacionesActuales,
  zonasCriticas,
} from './mapas.service.js';
import { alcanceDe, alcanceOVacio, episConPoligono, jurisdiccionDe } from './jurisdiccion.js';

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

// Motor de asignación (F2): una sola intención por operación.
const asignacionSchema = z.object({
    claveIdempotencia: z.string().uuid(),
    ejecucionId: z.string().uuid().optional(),
    rutaPlantillaId: z.string().uuid().optional(),
    // F4: asignar a un punto fijo del catálogo (punto o subpunto).
    puntoFijoId: z.string().uuid().optional(),
    nueva: z
      .object({
        nombre: z.string().trim().min(1).max(120),
        descripcion: z.string().trim().max(500).optional().nullable(),
        trazado: z.array(lngLat).min(2).max(2000),
        tipo: z.enum(TIPOS_RUTA),
      })
      .optional(),
    modalidad: z.enum(MODALIDADES).optional(),
    nombre: z.string().trim().max(120).optional().nullable(),
    descripcion: z.string().trim().max(500).optional().nullable(),
    unidad: z.string().trim().max(60).optional().nullable(),
    guardias: z
      .array(z.object({ guardiaId: z.string().uuid(), punto: lngLat.optional().nullable(), puntoFijoId: z.string().uuid().optional().nullable() }))
      .min(1)
      .max(50),
    confirmaciones: z.array(z.object({ guardiaId: z.string().uuid(), patrullaId: z.string().uuid() })).max(50).optional(),
  });

// Compatibilidad: endpoint individual anterior. Delega al MISMO motor (con
// capacidad, elegibilidad y confirmación de reasignación); ya no reemplaza en
// silencio la ruta anterior del guardia.
const asignarLegadoSchema = z.object({
  guardiaId: z.string().uuid(),
  rutaPlantillaId: z.string().uuid(),
  nombre: z.string().trim().max(120).optional().nullable(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  poligonoGeojson: z.object({ type: z.literal('Point'), coordinates: lngLat }).optional().nullable(),
  confirmarPatrullaId: z.string().uuid().optional(),
  claveIdempotencia: z.string().uuid().optional(),
});

// [lng, lat] pelado (no envuelto en GeoJSON) — ver comentario en
// mapas.service.ts:crearRutaPlantilla sobre por qué. El trazado ya viene
// ruteado por calles desde la Web (routing.ts, OSRM) — no son los 2-5
// puntos que clickeó el Operador, es el camino real con muchos vértices
// (rediseño 2026-09-14: "debe ir por las calles").
// Máx. 6 puntos por llamada (el breadcrumb de TelemetryDrawer solo muestrea
// 4) — evita que alguien mande cientos de puntos y dispare igual cantidad de
// requests secuenciales a Nominatim en una sola llamada.
const geocodificarSchema = z.object({
  puntos: z.array(z.object({ lat: z.number(), lng: z.number() })).min(1).max(6),
});

// Previsualización: solo hacen falta los guardias (se pide ANTES de dibujar
// la ruta). Las demás claves que mande la web se ignoran.
const previsualizarSchema = z.object({
  ejecucionId: z.string().uuid().optional(),
  puntoFijoId: z.string().uuid().optional(),
  guardias: z.array(z.object({ guardiaId: z.string().uuid() })).min(1).max(50),
});

// Biblioteca: crea una ruta predeterminada (establecida) o guardada sin
// asignarla a nadie. Sus parámetros aplican a cada asignación futura.
const crearRutaSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(500).optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  trazado: z.array(lngLat).min(2).max(2000),
  activo: z.boolean().optional(),
  modalidad: z.enum(MODALIDADES).optional().nullable(),
  tipo: z.enum(['establecida', 'guardada']).optional(),
});

const actualizarRutaSchema = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  descripcion: z.string().trim().max(500).optional().nullable(),
  tipo: z.enum(['establecida', 'guardada']).optional(),
  modalidad: z.enum(MODALIDADES).optional().nullable(),
});

function actorDe(req: AuthRequest): Actor {
  const p = req.principal!;
  return { id: p.id, role: p.role, permissions: p.permissions as Actor['permissions'] };
}

function aInput(req: AuthRequest, body: z.infer<typeof asignacionSchema>, jurisdiccion: Awaited<ReturnType<typeof jurisdiccionDe>>): AsignarInput {
  const origenes = [body.rutaPlantillaId, body.nueva, body.puntoFijoId].filter(Boolean).length;
  if (!body.ejecucionId && origenes !== 1) {
    throw Errors.validation('Indica UNA ruta guardada (rutaPlantillaId), un trazado nuevo (nueva) o un punto fijo (puntoFijoId).');
  }
  return {
    actor: actorDe(req),
    jurisdiccion,
    claveIdempotencia: body.claveIdempotencia,
    ejecucionId: body.ejecucionId,
    puntoFijoId: body.puntoFijoId,
    ruta: body.rutaPlantillaId ? { rutaPlantillaId: body.rutaPlantillaId } : body.nueva ? { nueva: body.nueva } : undefined,
    modalidad: body.modalidad,
    nombre: body.nombre,
    descripcion: body.descripcion,
    unidad: body.unidad,
    guardias: body.guardias,
    confirmaciones: body.confirmaciones,
  };
}

export function buildMapasRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/ubicaciones',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      // Disponibilidad GLOBAL (todos ven a todos los guardias y sus SOS);
      // el alcance solo decide si se ve el nombre de la ruta que lo ocupa.
      res.json({ data: await ubicacionesActuales(await alcanceOVacio(req.principal!)) });
    }),
  );

  router.get(
    '/patrullas',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await patrullasVigentes(await alcanceDe(req.principal!)) });
    }),
  );

  // Jurisdicción (2026-10-05): polígono + color de cada EPI para la capa
  // "cristal" del mapa, y la EPI del usuario (null = sin restricción,
  // super_admin). La Web la usa para bloquear dibujar fuera de su EPI; la
  // validación real está en el backend (crear/asignar/cancelar).
  router.get(
    '/jurisdiccion',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const principal = req.principal!;
      const epis = await episConPoligono();
      let miEpiCodigo: string | null = null;
      const restringido = principal.role !== 'super_admin';
      if (restringido) {
        try {
          miEpiCodigo = (await jurisdiccionDe(principal))?.epiCodigo ?? null;
        } catch (error) {
          // Una cuenta sin EPI es un estado funcional que la Web debe poder
          // mostrar. Los errores reales de base/conexión no se ocultan como
          // si fueran ese caso: llegan al errorHandler y responden 500.
          if (error instanceof AppError && error.code === 'FORBIDDEN') {
            miEpiCodigo = null;
          } else {
            throw error;
          }
        }
      }
      res.json({ data: { epis, miEpiCodigo, restringido } });
    }),
  );

  router.get(
    '/rutas',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await rutasPlantilla(await alcanceDe(req.principal!)) });
    }),
  );

  // Biblioteca: guardar una ruta sin asignar a nadie (no crea patrullas).
  // El permiso depende del tipo (lo valida el servicio): una predeterminada
  // (establecida) usa `rutas_establecidas`, que tienen los 3 roles web; una
  // guardada usa `patrullaje`.
  router.post(
    '/rutas',
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(crearRutaSchema, req.body);
      const jurisdiccion = await jurisdiccionDe(req.principal!);
      const ruta = await crearRutaPlantilla({ ...input, creadoPorId: req.principal!.id, actor: actorDe(req), jurisdiccion });
      res.status(201).json({ data: ruta });
    }),
  );

  // Parámetros de una ruta establecida/guardada (nombre, tipo, modalidad...).
  // Permiso por tipo de ruta, validado en el servicio.
  router.patch(
    '/rutas/:id',
    asyncHandler(async (req: AuthRequest, res) => {
      const patch = validate(actualizarRutaSchema, req.body);
      const ruta = await actualizarRutaPlantilla(req.params.id!, patch, actorDe(req), await jurisdiccionDe(req.principal!));
      res.json({ data: ruta });
    }),
  );

  // Quita una ruta de la biblioteca (borrado lógico: activo=false). Las
  // asignaciones en curso siguen: tienen su propia copia del trazado.
  router.patch(
    '/rutas/:id/archivar',
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await archivarRutaPlantilla(req.params.id!, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  // Compatibilidad: "cancelar la ruta" de una plantilla = cancelar SUS
  // ejecuciones vigentes (cada una por separado). La web usa ahora
  // PATCH /ejecuciones/:id/cancelar.
  router.patch(
    '/rutas/:id/cancelar',
    authorize('patrullaje', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const j = await jurisdiccionDe(req.principal!);
      const ejecuciones = await db.rutaEjecucion.findMany({
        where: { rutaPlantillaId: req.params.id!, estado: { in: ['pendiente', 'activa', 'incompleta'] } },
        select: { id: true },
      });
      if (ejecuciones.length === 0) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No hay guardias con esta ruta vigente para cancelar.' } });
        return;
      }
      let cancelados = 0;
      for (const e of ejecuciones) cancelados += (await cancelarEjecucion(e.id, actorDe(req), j)).cancelados;
      res.json({ data: { rutaPlantillaId: req.params.id, cancelados } });
    }),
  );

  // Previsualización: conflictos de reasignación y avisos de GPS, sin escribir.
  router.post(
    '/ejecuciones/previsualizar',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const body = validate(previsualizarSchema, req.body);
      res.json({ data: await previsualizarAsignacion({ ...body, jurisdiccion: await jurisdiccionDe(req.principal!) }) });
    }),
  );

  // Asignar una ruta a un grupo de guardias: se asigna a los aptos y se
  // informa quién no pudo asignarse (`noAsignados`).
  router.post(
    '/ejecuciones',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const body = validate(asignacionSchema, req.body);
      const resultado = await asignarEjecucion(aInput(req, body, await jurisdiccionDe(req.principal!)));
      res.status(201).json({ data: resultado });
    }),
  );

  // Cancela UNA ejecución (no las demás de la misma plantilla).
  router.patch(
    '/ejecuciones/:id/cancelar',
    authorize('patrullaje', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await cancelarEjecucion(req.params.id!, actorDe(req), await jurisdiccionDe(req.principal!)) });
    }),
  );

  // Saca a UN guardia de su ruta; si la ruta queda vacía, se cierra.
  // F6: en un horario automático, `reposicion` decide si se busca al reemplazo
  // más cercano ('automatica', por defecto) o el horario pasa a manual.
  router.patch(
    '/patrullas/:id/cancelar',
    authorize('patrullaje', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { reposicion } = validate(z.object({ reposicion: z.enum(['automatica', 'manual']).optional() }), req.body ?? {});
      const r = await retirarGuardia(req.params.id!, actorDe(req), await jurisdiccionDe(req.principal!), { reposicion });
      // Reemplazo al momento, sin esperar la próxima pasada del planificador.
      if (r.reposicion === 'automatica' && r.ejecucionId) void intentarAhora(r.ejecucionId);
      res.json({ data: r });
    }),
  );

  router.post(
    '/patrullas',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(asignarLegadoSchema, req.body);
      const activa = input.confirmarPatrullaId ? [{ guardiaId: input.guardiaId, patrullaId: input.confirmarPatrullaId }] : [];
      const resultado = await asignarEjecucion({
        actor: actorDe(req),
        jurisdiccion: await jurisdiccionDe(req.principal!),
        claveIdempotencia: input.claveIdempotencia ?? crypto.randomUUID(),
        ruta: { rutaPlantillaId: input.rutaPlantillaId },
        nombre: input.nombre,
        descripcion: input.descripcion,
        guardias: [{ guardiaId: input.guardiaId, punto: input.poligonoGeojson?.coordinates ?? null }],
        confirmaciones: activa,
      });
      res.status(201).json({ data: { id: resultado.patrullaIds[0], ejecucionId: resultado.ejecucion.id } });
    }),
  );

  // Geocodificación inversa en lote para el breadcrumb de ruta del
  // TelemetryDrawer (Web) — usa el mismo servicio throttled/cacheado que
  // ubicacionesActuales, nunca llama a Nominatim directo desde el navegador
  // (ver comentario en geocodificarPuntos, mapas.service.ts).
  router.post(
    '/geocodificar',
    authorize('mapas', 'ver'),
    asyncHandler(async (req, res) => {
      const { puntos } = validate(geocodificarSchema, req.body);
      res.json({ data: await geocodificarPuntos(puntos) });
    }),
  );

  router.get(
    '/zonas',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await zonasCriticas(await alcanceDe(req.principal!)) });
    }),
  );

  router.get(
    '/heatmap',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      res.json({
        data: await heatmap(await alcanceDe(req.principal!), { desde: str(req.query.desde), hasta: str(req.query.hasta), epiId: str(req.query.epiId) }),
      });
    }),
  );

  router.post(
    '/zonas/recalcular',
    authorize('patrullaje', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      res.json({ data: await recalcularZonasCriticas(req.principal!.id, await alcanceDe(req.principal!)) });
    }),
  );

  // Recorrido real: por turno, o por guardia + ventana temporal.
  router.get(
    '/recorrido',
    authorize('mapas', 'ver'),
    asyncHandler(async (req: AuthRequest, res) => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      const data = await recorridoQuery({
        turnoId: str(req.query.turnoId),
        guardiaId: str(req.query.guardiaId),
        desde: str(req.query.desde),
        hasta: str(req.query.hasta),
      });
      // F3: fuera de la supervisión global, solo los tramos de rutas de su EPI.
      const alcance = await alcanceDe(req.principal!);
      res.json({ data: alcance.tipo === 'global' || !data.guardiaId ? data : recortarRecorrido(data, await ventanasAutorizadas(data.guardiaId, alcance.epiId)) });
    }),
  );

  return router;
}
