import { Router } from 'express';
import { asyncHandler, Errors } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { MIME_A_EXT, upload } from './media.storage.js';

// Subida de archivos de la app móvil (Bearer, guardia): selfie de inicio de
// turno (`POST /turnos`) y evidencia foto/video de un hecho (`POST
// /hechos`). Antes de este endpoint la app mandaba el URI local del
// celular (file://...) como si fuera la URL final — "funcionaba" para el
// guardia que lo subió (su propio celular reabre su propio archivo local)
// pero era un link roto para cualquier otro (la web nunca podía mostrar esa
// selfie/evidencia). Flujo real: la app sube el archivo aquí primero, y
// recién con la URL que devuelve este endpoint llama a /turnos o /hechos.
//
// Devuelve la URL construida con el host real de la petición
// (`req.protocol` + `req.get('host')`), no un dominio fijo por config: así
// funciona igual si la piden desde localhost (web) o desde la IP LAN
// (celular), sin variable de entorno aparte que mantener sincronizada.
export function buildMediaRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(authenticate(tokens), requireGuardia);

  router.post(
    '/',
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (err) {
          next(Errors.validation(err instanceof Error ? err.message : 'No se pudo procesar el archivo.'));
          return;
        }
        next();
      });
    },
    asyncHandler(async (req: AuthRequest, res) => {
      if (!req.file) throw Errors.validation('Falta el archivo (campo "file").');
      const info = MIME_A_EXT[req.file.mimetype];
      res.status(201).json({
        data: {
          url: `${req.protocol}://${req.get('host')}/media/${req.file.filename}`,
          tipo: info!.tipo,
        },
      });
    }),
  );

  return router;
}
