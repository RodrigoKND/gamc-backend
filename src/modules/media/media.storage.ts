import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

// Almacenamiento de archivos subidos (selfie de inicio de turno + evidencia
// foto/video de un hecho) — BD_UNIFICADA solo definía la columna `url`
// (turno.selfie_inicio_url / hecho_evidencia.url), nunca dónde vivía el
// binario. Disco local del servidor: mismo criterio que el resto del
// proyecto ("un solo servidor controla su Postgres", BD_UNIFICADA §9) — sin
// depender de S3/Cloudinary hasta que haga falta escalar más allá de un
// servidor. Se sirve estático desde /media/<archivo> (ver app.ts).

export const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// El nombre de archivo NUNCA sale del cliente (ni de `originalname`, que un
// atacante controla por completo): se genera con un UUID propio y la
// extensión se resuelve contra la lista blanca de MIME_A_EXT, no contra lo
// que el cliente diga que es. Elimina cualquier vector de path traversal o
// de "subir un .html/.php disfrazado de foto".
export const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const info = MIME_A_EXT[file.mimetype];
    cb(null, `${randomUUID()}${info?.ext ?? ''}`);
  },
});

export const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_A_EXT[file.mimetype]) {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});
