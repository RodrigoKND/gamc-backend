// Setup automático de la base de datos para desarrollo local.
//
// Uso:  npm run db:setup            (crea la BD, carga el schema, marca la
//                                    migración como aplicada y corre el seed)
//       npm run db:setup -- --no-seed
//
// Requisitos:
//   - Un Postgres accesible y las credenciales correctas en .env (DATABASE_URL).
//   - El script fuente único del schema: se busca en el orden
//       1. variable de entorno DB_SCHEMA_SQL
//       2. gamc-api/database/schema.sql
//       3. ../GAMC/database/schema.sql (repo web, fuente de verdad compartida)
//
// ADVERTENCIA: restablece por completo la BD local (DROP SCHEMA public CASCADE)
// para que el resultado sea idéntico en cada ejecución.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, '..');

const noSeed = process.argv.includes('--no-seed');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Falta DATABASE_URL en .env. Copia .env.example a .env con tus credenciales de PostgreSQL.');
  process.exit(1);
}

function findSchemaFile() {
  const candidates = [
    process.env.DB_SCHEMA_SQL,
    join(API_ROOT, 'database', 'schema.sql'),
    resolve(API_ROOT, '..', 'GAMC', 'database', 'schema.sql'),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error(
      'No se encontró el script del schema (schema.sql). ' +
        'Definí DB_SCHEMA_SQL o dejá el repo GAMC junto a gamc-api.',
    );
    process.exit(1);
  }
  return found;
}

function prisma(args, input, { ignoreCodes = [], label } = {}) {
  const options = {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  };
  if (typeof input === 'string' || input instanceof Buffer) {
    options.input = input;
  }
  const result = spawnSync(process.execPath, [join('node_modules', 'prisma', 'build', 'index.js'), ...args], options);
  const ok = result.status === 0 || ignoreCodes.some((code) => result.stderr?.includes(code));
  if (!ok) {
    console.error(`[setup] ${label ?? args.join(' ')} falló:`);
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  return result;
}

function urlWithDatabase(url, database) {
  try {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  } catch {
    return url.replace(/\/[^/?#]*(\?|#|$)/, `/${database}$1`);
  }
}

const schemaFile = findSchemaFile();
const targetDb = (() => {
  try {
    return new URL(dbUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

console.log(`[setup] Puerto/host según DATABASE_URL. Schema fuente: ${schemaFile}`);

// Supabase (y cualquier Postgres administrado) solo expone la BD "postgres":
// no se puede ni se debe crear una BD hermana ahí. Ese paso solo aplica para
// Postgres local con una BD "gamc_seguridad" dedicada.
if (targetDb && targetDb !== 'postgres') {
  const adminUrl = urlWithDatabase(dbUrl, 'postgres');
  prisma(
    ['db', 'execute', '--url', adminUrl, '--stdin'],
    `CREATE DATABASE ${targetDb};`,
    { ignoreCodes: ['already exists'], label: 'crear base de datos' },
  );
  console.log('[setup] Base de datos lista.');
} else {
  console.log('[setup] BD "postgres" (Supabase): se omite CREATE DATABASE.');
}

prisma(
  ['db', 'execute', '--url', dbUrl, '--stdin'],
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  { label: 'reiniciar schema' },
);
console.log('[setup] Schema reiniciado.');

prisma(
  ['db', 'execute', '--url', dbUrl, '--file', schemaFile],
  {},
  { label: 'cargar schema.sql' },
);
console.log('[setup] schema.sql cargado.');

prisma(
  ['migrate', 'resolve', '--applied', '0001_init'],
  {},
  { ignoreCodes: ['already been marked as applied'], label: 'marco migración como aplicada' },
);
console.log('[setup] Migración 0001_init marcada como aplicada.');

if (noSeed) {
  console.log('[setup] Listo (sin seed). Corré  npm run db:seed  cuando quieras datos demo.');
} else {
  prisma(['db', 'seed'], {}, { label: 'seed' });
  console.log('[setup] Listo. Datos demo sembrados.');
}
console.log('Corré  npm run dev  para levantar el API en http://localhost:4000');