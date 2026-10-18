import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, authorize, type AuthRequest } from '@modules/auth/http/middlewares';
import { can } from '@shared/policies';
import { Errors } from '@shared/errors';
import { desconectarUsuario } from '@infra/realtime';
import { logAudit } from '@modules/auditoria/auditoria.service';
import { createUser, listRoles, listUsers, setUserEstado, updateUser } from './usuarios.service.js';

const createUserSchema = z.object({
  rol: z.enum(['super_admin', 'admin', 'operador_monitoreo']),
  primerNombre: z.string().trim().min(2).max(60),
  segundoNombre: z.string().trim().max(60).optional().nullable(),
  apellidoPaterno: z.string().trim().min(2).max(60),
  apellidoMaterno: z.string().trim().min(2).max(60),
  email: z.string().trim().email().toLowerCase(),
  usuario: z.string().trim().min(4).max(40),
  ci: z.string().trim().min(4).max(20).optional().nullable(),
  telefono: z.string().trim().max(20).optional().nullable(),
  fechaNacimiento: z.string().optional().nullable(),
  // Código del catálogo dinámico (/api/epis); el servicio valida que exista y esté activa.
  epiCodigo: z.string().trim().min(2).max(40).optional().nullable(),
});

export function buildUsuariosRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/roles',
    authorize('usuarios', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listRoles() });
    }),
  );

  router.get(
    '/',
    authorize('usuarios', 'ver'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listUsers() });
    }),
  );

  router.post(
    '/',
    authorize('usuarios', 'crear'),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(createUserSchema, req.body);
      const result = await createUser({ ...input, creadoPorId: req.principal!.id });
      res.status(201).json({ data: result });
    }),
  );

  router.patch(
    '/:id',
    authorize('usuarios', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const patch = validate(createUserSchema.partial(), req.body);
      // F3: la EPI de una cuenta define qué datos ve y modifica. Cambiarla
      // exige `jurisdiccion_usuarios` (solo Super Admin); antes bastaba
      // usuarios.editar, que tiene el Admin, incluso sobre su propia cuenta.
      const cambiaEpi = patch.epiCodigo !== undefined;
      if (cambiaEpi && !can(req.principal!.permissions, 'jurisdiccion_usuarios', 'editar')) {
        throw Errors.forbidden('Solo el Super Administrador puede cambiar la EPI de una cuenta.');
      }
      const user = await updateUser(req.params.id!, patch);
      if (cambiaEpi) {
        await logAudit({ actorUserId: req.principal!.id, accion: 'cambiar_epi_usuario', recurso: 'usuarios', recursoId: req.params.id!, detalle: { epiCodigo: patch.epiCodigo ?? null } });
        // Sus conexiones en vivo se cierran: al reconectar recibe las salas de su nueva EPI.
        desconectarUsuario(req.params.id!);
      }
      res.json({ data: { user } });
    }),
  );

  router.patch(
    '/:id/estado',
    authorize('usuarios', 'editar'),
    asyncHandler(async (req: AuthRequest, res) => {
      const { estado } = validate(z.object({ estado: z.enum(['activo', 'inactivo', 'suspendido']) }), req.body);
      const user = await setUserEstado(req.params.id!, estado, req.principal!.id);
      res.json({ data: { user } });
    }),
  );

  return router;
}

