import 'dotenv/config';
import { z } from 'zod';

// Configuración tipada y validada en un solo punto (patrón Config Object).
// Cualquier variable nueva se agrega AQUÍ, nunca se lee process.env en el
// resto del código: cambiar una variable = tocar solo este archivo.

// Variable opcional: vacía en el .env cuenta como no definida.
const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria (schema.sql en GAMC/database)'),

  // Pool de Prisma. Se aplican solo si DATABASE_URL no trae ya
  // `connection_limit` / `pool_timeout`. En hosting compartido, un pool chico
  // evita agotar `max_connections` de PostgreSQL.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_POOL_TIMEOUT_S: z.coerce.number().int().min(1).max(120).default(20),

  // Coste de bcrypt para hashes NUEVOS (OWASP: >= 10). Los hashes existentes
  // con otro coste se migran solos en el siguiente login correcto.
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  // TTL (segundos) de la caché de lecturas agregadas del dashboard.
  DASHBOARD_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(5),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).default(7),

  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  DEV_RETURN_RESET_CODE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  RESET_CODE_MINUTES: z.coerce.number().int().min(1).default(10),

  // Almacenamiento de fotos y videos compatible con S3 (RustFS en Docker).
  // Las cinco variables S3_* juntas activan el almacenamiento remoto; sin
  // ellas se usan las R2_* históricas y, si tampoco hay, `uploads/` (solo dev).
  S3_ENDPOINT: opcional(z.string().url()),
  S3_REGION: opcional(z.string()),
  S3_ACCESS_KEY_ID: opcional(z.string()),
  S3_SECRET_ACCESS_KEY: opcional(z.string()),
  S3_BUCKET: opcional(z.string()),
  // RustFS responde en path-style cuando no se configura RUSTFS_SERVER_DOMAINS.
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Cloudflare R2: se mantiene para no romper despliegues ya existentes.
  R2_ACCOUNT_ID: opcional(z.string()),
  R2_ACCESS_KEY_ID: opcional(z.string()),
  R2_SECRET_ACCESS_KEY: opcional(z.string()),
  R2_BUCKET: opcional(z.string()),
  R2_PUBLIC_URL: opcional(z.string().url()),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // El servidor no debe arrancar con configuración inválida — falla temprano.
  console.error('Configuración de entorno inválida:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;

const S3_VARS = ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const;
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'] as const;

/**
 * Un único objeto de configuración para el almacenamiento de evidencias.
 * `s3` es el destino nuevo (RustFS); `r2` conserva el contrato histórico para
 * instalaciones ya desplegadas; `local` sigue sirviendo `uploads/` en desarrollo.
 */
export type AlmacenamientoMedia =
  | { modo: 'local' }
  | {
      modo: 's3';
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      forcePathStyle: boolean;
    }
  | {
      modo: 'r2';
      endpoint: string;
      region: 'auto';
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      forcePathStyle: false;
      publicUrl: string;
    };

function resolverAlmacenamiento(): AlmacenamientoMedia {
  const s3Definidas = S3_VARS.filter((k) => env[k]);
  if (s3Definidas.length > 0 && s3Definidas.length < S3_VARS.length) {
    console.error(`Configuración de almacenamiento S3 incompleta. Faltan: ${S3_VARS.filter((k) => !env[k]).join(', ')}`);
    process.exit(1);
  }
  if (s3Definidas.length === S3_VARS.length) {
    return {
      modo: 's3',
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      bucket: env.S3_BUCKET!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    };
  }

  const r2Definidas = R2_VARS.filter((k) => env[k]);
  if (r2Definidas.length > 0 && r2Definidas.length < R2_VARS.length) {
    console.error(`Configuración de Cloudflare R2 incompleta. Faltan: ${R2_VARS.filter((k) => !env[k]).join(', ')}`);
    process.exit(1);
  }
  if (r2Definidas.length === R2_VARS.length) {
    return {
      modo: 'r2',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: 'auto',
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucket: env.R2_BUCKET!,
      forcePathStyle: false,
      publicUrl: env.R2_PUBLIC_URL!,
    };
  }

  return { modo: 'local' };
}

export const almacenamientoMedia = resolverAlmacenamiento();

export const IS_PROD = env.NODE_ENV === 'production';
export const IS_DEV = !IS_PROD;