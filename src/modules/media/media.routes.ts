import { Router } from 'express';
import { asyncHandler, Errors } from '@shared/index';
import type { TokenService } from '@modules/auth/application/token.service';
import { authenticate, requireGuardia, type AuthRequest } from '@modules/auth/http/middlewares';
import { descargarArchivo, guardarArchivo, upload } from './media.storage.js';

// Subida de archivos de la app móvil (Bearer, guardia): selfie de inicio de
// turno (`POST /turnos`) y evidencia foto/video de un hecho (`POST
// /hechos`). Antes de este endpoint la app mandaba el URI local del
// celular (file://...) como si fuera la URL final — "funcionaba" para el
// guardia que lo subió (su propio celular reabre su propio archivo local)
// pero era un link roto para cualquier otro (la web nunca podía mostrar esa
// selfie/evidencia). Flujo real: la app sube el archivo aquí primero, y
// recién con la URL que devuelve este endpoint llama a /turnos o /hechos.
//
// Devuelve la URL pública definitiva: `/media/...` servida por este API
// (RustFS o desarrollo local) o la del bucket en despliegues R2 históricos.
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
      res.status(201).json({ data: await guardarArchivo(req.file, `${req.protocol}://${req.get('host')}`) });
    }),
  );

  return router;
}

/**
 * Sirve los binarios guardados en RustFS sin exponer el S3 al navegador.
 * Se monta en `/media` solo cuando hay almacenamiento remoto; en local basta
 * `express.static` sobre `uploads/`.
 */
export function buildMediaPublicRouter(): Router {
  const router = Router();

  router.get('/:clave(*)', asyncHandler(async (req, res) => {
    const { bytes, contentType } = await descargarArchivo(req.params.clave!);
    res.set({
      'Content-Type': contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(bytes);
  }));

  return router;
}
