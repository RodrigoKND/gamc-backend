import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '@config/env';

// Singleton del ORM (Prisma). Todas las consultas del backend pasan por este
// cliente o por `withTransaction` (misma conexión, caso de uso transaccional).
// En tests se inyecta un PrismaClient con la misma forma (duck-typed).

export type Tx = Prisma.TransactionClient;

/** Añade los límites del pool a la URL salvo que ya los traiga. */
function urlConPool(raw: string): string {
  const url = new URL(raw);
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', String(env.DB_POOL_MAX));
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', String(env.DB_POOL_TIMEOUT_S));
  return url.toString();
}

export const db = new PrismaClient({
  datasources: { db: { url: urlConPool(env.DATABASE_URL) } },
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction((tx) => fn(tx));
}