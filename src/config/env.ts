import 'dotenv/config';
import { z } from 'zod';

// Configuración tipada y validada en un solo punto (patrón Config Object).
// Cualquier variable nueva se agrega AQUÍ, nunca se lee process.env en el
// resto del código: cambiar una variable = tocar solo este archivo.

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria (schema.sql en GAMC/database)'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
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

export const IS_PROD = env.NODE_ENV === 'production';
export const IS_DEV = !IS_PROD;