import { Router } from "express";
import { z } from "zod";
import { asyncHandler, validate } from "@shared/index";
import type { TokenService } from "@modules/auth/application/token.service";
import {
  authenticate,
  authorize,
  type AuthRequest,
} from "@modules/auth/http/middlewares";
import {
  createGuardia,
  getGuardia,
  listGuardias,
  setEstadoCuenta,
  setEstadoOperativo,
  updateGuardia,
} from "./guardias.service.js";

const updateSchema = z.object({
  primerNombre: z.string().trim().min(2).max(60).optional(),
  segundoNombre: z.string().trim().max(60).optional().nullable(),
  apellidoPaterno: z.string().trim().min(2).max(60).optional(),
  apellidoMaterno: z.string().trim().min(2).max(60).optional(),
  ci: z.string().trim().min(4).max(20).optional(),
  telefono: z.string().trim().max(20).optional(),
  fotoUrl: z.string().url().optional().nullable(),
  epiId: z.string().uuid().optional().nullable(),
  epiCodigo: z.string().trim().max(40).optional().nullable(),
});

const createSchema = z.object({
  primerNombre: z.string().trim().min(2).max(60),
  segundoNombre: z.string().trim().max(60).optional().nullable(),
  apellidoPaterno: z.string().trim().min(2).max(60),
  apellidoMaterno: z.string().trim().min(2).max(60),
  ci: z.string().trim().min(4).max(20),
  telefono: z.string().trim().max(20),
  fechaNacimiento: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Fecha inválida (DD/MM/AAAA)."),
  epiCodigo: z.string().trim().max(40).optional().nullable(),
});

export function buildGuardiasRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    "/",
    authorize("guardias", "ver"),
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const epi = typeof req.query.epi === 'string' ? req.query.epi : typeof req.query.epiCodigo === 'string' ? req.query.epiCodigo : undefined;
      const estado = typeof req.query.estado === 'string' ? req.query.estado : undefined;
      const estadoOperativo = typeof req.query.estadoOperativo === 'string' ? req.query.estadoOperativo : undefined;
      const excluirInactivos = req.query.excluirInactivos === '1' || req.query.excluirInactivos === 'true';
      const page = req.query.page ? Number(req.query.page) : undefined;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
      const { rows, total } = await listGuardias(true, { q, epiCodigo: epi, estado, estadoOperativo, excluirInactivos, page, pageSize });
      res.json({ data: rows, meta: { total, page, pageSize } });
    }),
  );

  router.post(
    "/",
    authorize("guardias", "crear"),
    asyncHandler(async (req: AuthRequest, res) => {
      const input = validate(createSchema, req.body);
      const fechaNacimiento = new Date(
        Number(input.fechaNacimiento.slice(6, 10)),
        Number(input.fechaNacimiento.slice(3, 5)) - 1,
        Number(input.fechaNacimiento.slice(0, 2)),
      );
      const result = await createGuardia({
        ...input,
        fechaNacimiento,
        creadoPorId: req.principal!.id,
      });
      res.status(201).json({ data: result });
    }),
  );

  router.get(
    "/:id",
    authorize("guardias", "ver"),
    asyncHandler(async (req, res) => {
      const guardia = await getGuardia(req.params.id!!);
      if (!guardia)
        return res
          .status(404)
          .json({
            error: { code: "NOT_FOUND", message: "GuardÃ­a no encontrado." },
          });
      res.json({ data: guardia });
    }),
  );

  router.patch(
    "/:id",
    authorize("guardias", "editar"),
    asyncHandler(async (req, res) => {
      const patch = validate(updateSchema, req.body);
      const guardia = await updateGuardia(req.params.id!, patch);
      res.json({ data: guardia });
    }),
  );

  router.patch(
    "/:id/estado",
    authorize("guardias", "editar"),
    asyncHandler(async (req: AuthRequest, res) => {
      const { estado } = validate(
        z.object({ estado: z.enum(["activo", "inactivo", "suspendido"]) }),
        req.body,
      );
      const guardia = await setEstadoCuenta(
        req.params.id!,
        estado,
        req.principal!.id,
      );
      res.json({ data: guardia });
    }),
  );

  router.patch(
    "/:id/estado-operativo",
    authorize("guardias", "editar"),
    asyncHandler(async (req: AuthRequest, res) => {
      const { estadoOperativo } = validate(
        z.object({
          estadoOperativo: z.enum([
            "fuera_de_servicio",
            "en_servicio",
            "emergencia",
          ]),
        }),
        req.body,
      );
      const guardia = await setEstadoOperativo(
        req.params.id!,
        estadoOperativo,
        req.principal!.id,
      );
      res.json({ data: guardia });
    }),
  );

  return router;
}
