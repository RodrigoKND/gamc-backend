import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import type { S3Client } from '@aws-sdk/client-s3';
import { almacenamientoMedia } from '@config/env';
import { Errors } from '@shared/index';
import { logger } from '@infra/logger';

// Almacenamiento de archivos subidos (selfie de inicio de turno + evidencia
// foto/video de un hecho). La BD solo guarda la URL
// (turno.selfie_inicio_url / hecho_evidencia.url).
//
// · Con S3_* (RustFS en Docker): el binario viaja al bucket por la API S3 de
//   la red interna y se sirve por `/media/<clave>`; RustFS no se expone.
// · Con R2_* (despliegues anteriores): se mantiene la URL pública del bucket.
// · Sin ninguna de las dos (desarrollo local): carpeta `uploads/` en /media.

export const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

export const MIME_A_EXT: Record<string, { ext: string; tipo: 'foto' | 'video' }> = {
  'image/jpeg': { ext: '.jpg', tipo: 'foto' },
  'image/png': { ext: '.png', tipo: 'foto' },
  'image/webp': { ext: '.webp', tipo: 'foto' },
  'video/mp4': { ext: '.mp4', tipo: 'video' },
  'video/quicktime': { ext: '.mov', tipo: 'video' },
};

// Solo se sirven las claves que este servidor puede generar: UUID + extensión
// de la lista blanca, dentro de `fotos/` o `videos/`. Así `/media` nunca se
// convierte en un lector arbitrario del bucket.
const CLAVE_PERMITIDA = /^(fotos|videos)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|mov)$/;

// Cubre una selfie + un video corto de evidencia; suficiente para el uso
// real (una foto o un clip por request, nunca un archivo por lote).
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// El archivo queda en memoria (≤ 25 MB) y se entrega al destino elegido.
// El nombre NUNCA sale del cliente (ni de `originalname`, que un atacante
// controla por completo): se genera con un UUID propio y la extensión se
// resuelve contra la lista blanca de MIME_A_EXT. Elimina cualquier vector de
// path traversal o de "subir un .html/.php disfrazado de foto".
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_A_EXT[file.mimetype]) {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

// El SDK de S3 se importa bajo demanda: el API debe arrancar aunque el paquete
// no esté instalado cuando se usa almacenamiento local.
let clienteRemoto: Promise<S3Client> | null = null;

function clienteS3(): Promise<S3Client> {
  const configuracion = almacenamientoMedia;
  if (configuracion.modo === 'local') return Promise.reject(Errors.validation('Almacenamiento remoto no configurado.'));

  clienteRemoto ??= import('@aws-sdk/client-s3')
    .then(
      ({ S3Client: Client }) =>
        new Client({
          region: configuracion.region,
          endpoint: configuracion.endpoint,
          forcePathStyle: configuracion.forcePathStyle,
          credentials: {
            accessKeyId: configuracion.accessKeyId,
            secretAccessKey: configuracion.secretAccessKey,
          },
        }),
    )
    .catch((err: unknown) => {
      clienteRemoto = null; // permite reintentar si fue un fallo transitorio
      throw err;
    });
  return clienteRemoto;
}

if (almacenamientoMedia.modo === 'local') {
  void fs.mkdir(UPLOADS_DIR, { recursive: true });
  logger.info({ dir: UPLOADS_DIR }, 'Media: almacenamiento local (S3/R2 no configurado)');
} else {
  logger.info(
    { modo: almacenamientoMedia.modo, bucket: almacenamientoMedia.bucket, endpoint: almacenamientoMedia.endpoint },
    'Media: almacenamiento remoto configurado',
  );
}

export interface ArchivoGuardado {
  url: string;
  tipo: 'foto' | 'video';
}

/**
 * Guarda el archivo y devuelve su URL pública definitiva.
 * `origenLocal` (protocolo + host de la petición) solo se usa en local y con
 * RustFS: el binario se sirve por `/media`, detrás del reverse proxy.
 */
export async function guardarArchivo(file: Express.Multer.File, origenLocal: string): Promise<ArchivoGuardado> {
  const info = MIME_A_EXT[file.mimetype]!;
  const nombre = `${randomUUID()}${info.ext}`;

  if (almacenamientoMedia.modo !== 'local') {
    const clave = `${info.tipo === 'foto' ? 'fotos' : 'videos'}/${nombre}`;
    const [{ PutObjectCommand }, cliente] = await Promise.all([import('@aws-sdk/client-s3'), clienteS3()]);
    await cliente.send(
      new PutObjectCommand({
        Bucket: almacenamientoMedia.bucket,
        Key: clave,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    if (almacenamientoMedia.modo === 'r2') {
      return { url: `${almacenamientoMedia.publicUrl.replace(/\/+$/, '')}/${clave}`, tipo: info.tipo };
    }
    return { url: `${origenLocal.replace(/\/+$/, '')}/media/${clave}`, tipo: info.tipo };
  }

  await fs.writeFile(path.join(UPLOADS_DIR, nombre), file.buffer);
  return { url: `${origenLocal.replace(/\/+$/, '')}/media/${nombre}`, tipo: info.tipo };
}

/** Devuelve el binario de una evidencia desde el almacenamiento remoto. */
export async function descargarArchivo(clave: string): Promise<{ bytes: Buffer; contentType?: string }> {
  if (almacenamientoMedia.modo === 'local' || !CLAVE_PERMITIDA.test(clave)) {
    throw Errors.notFound('Archivo no encontrado.');
  }

  const [{ GetObjectCommand }, cliente] = await Promise.all([import('@aws-sdk/client-s3'), clienteS3()]);
  let objeto;
  try {
    objeto = await cliente.send(new GetObjectCommand({ Bucket: almacenamientoMedia.bucket, Key: clave }));
  } catch (error) {
    // Un enlace viejo o un archivo borrado es un 404, no un error del servidor.
    if (error instanceof Error && error.name === 'NoSuchKey') throw Errors.notFound('Archivo no encontrado.');
    throw error;
  }
  if (!objeto.Body) throw Errors.notFound('Archivo no encontrado.');

  return { bytes: Buffer.from(await objeto.Body.transformToByteArray()), contentType: objeto.ContentType };
}

export async function eliminarArchivo(url: string): Promise<void> {
  if (almacenamientoMedia.modo !== 's3') return;

  let clave: string;
  try {
    const destino = new URL(url);
    if (!destino.pathname.startsWith('/media/')) return;
    clave = decodeURIComponent(destino.pathname.slice('/media/'.length));
  } catch {
    return;
  }
  if (!CLAVE_PERMITIDA.test(clave)) return;

  const [{ DeleteObjectCommand }, cliente] = await Promise.all([import('@aws-sdk/client-s3'), clienteS3()]);
  try {
    await cliente.send(new DeleteObjectCommand({ Bucket: almacenamientoMedia.bucket, Key: clave }));
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return;
    throw error;
  }
}
