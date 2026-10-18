import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import type { S3Client } from '@aws-sdk/client-s3';
import { env, r2Configurado } from '@config/env';
import { logger } from '@infra/logger';

// Almacenamiento de archivos subidos (selfie de inicio de turno + evidencia
// foto/video de un hecho). La BD solo guarda la URL pública
// (turno.selfie_inicio_url / hecho_evidencia.url).
//
// · Con las variables R2_* definidas → Cloudflare R2 (API compatible con S3).
//   El binario no toca el disco del servidor: sobrevive a reinicios y
//   despliegues y se sirve desde el dominio público del bucket.
// · Sin ellas (desarrollo local) → carpeta `uploads/`, servida en /media.

export const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

export const MIME_A_EXT: Record<string, { ext: string; tipo: 'foto' | 'video' }> = {
  'image/jpeg': { ext: '.jpg', tipo: 'foto' },
  'image/png': { ext: '.png', tipo: 'foto' },
  'image/webp': { ext: '.webp', tipo: 'foto' },
  'video/mp4': { ext: '.mp4', tipo: 'video' },
  'video/quicktime': { ext: '.mov', tipo: 'video' },
};

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

// El SDK de S3 pesa y solo hace falta con R2: se importa bajo demanda para
// que el API arranque aunque el paquete no esté instalado (almacenamiento local).
let r2: Promise<S3Client> | null = null;

function clienteR2(): Promise<S3Client> {
  r2 ??= import('@aws-sdk/client-s3')
    .then(
      ({ S3Client: Client }) =>
        new Client({
          region: 'auto',
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
        }),
    )
    .catch((err: unknown) => {
      r2 = null; // permite reintentar si fue un fallo transitorio
      throw err;
    });
  return r2;
}

if (!r2Configurado) {
  void fs.mkdir(UPLOADS_DIR, { recursive: true });
  logger.info({ dir: UPLOADS_DIR }, 'Media: almacenamiento local (R2 no configurado)');
}

export interface ArchivoGuardado {
  url: string;
  tipo: 'foto' | 'video';
}

/**
 * Guarda el archivo y devuelve su URL pública definitiva.
 * `origenLocal` (protocolo + host de la petición) solo se usa sin R2, para
 * que la URL funcione igual desde localhost (web) o la IP LAN (celular).
 */
export async function guardarArchivo(file: Express.Multer.File, origenLocal: string): Promise<ArchivoGuardado> {
  const info = MIME_A_EXT[file.mimetype]!;
  const nombre = `${randomUUID()}${info.ext}`;

  if (r2Configurado) {
    const clave = `${info.tipo === 'foto' ? 'fotos' : 'videos'}/${nombre}`;
    const [{ PutObjectCommand }, cliente] = await Promise.all([import('@aws-sdk/client-s3'), clienteR2()]);
    await cliente.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: clave,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { url: `${env.R2_PUBLIC_URL!.replace(/\/+$/, '')}/${clave}`, tipo: info.tipo };
  }

  await fs.writeFile(path.join(UPLOADS_DIR, nombre), file.buffer);
  return { url: `${origenLocal}/media/${nombre}`, tipo: info.tipo };
}
