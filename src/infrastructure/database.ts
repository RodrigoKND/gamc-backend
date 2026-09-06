import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';

// Singleton del ORM (Prisma). Todas las consultas del backend pasan por este
// cliente o por `withTransaction` (misma conexión, caso de uso transaccional).
// En tests se inyecta un PrismaClient con la misma forma (duck-typed).

export type Tx = Prisma.TransactionClient;

export const db = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction((tx) => fn(tx));
}