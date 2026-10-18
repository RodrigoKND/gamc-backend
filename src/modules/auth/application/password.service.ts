import bcrypt from 'bcryptjs';
import { env } from '@config/env';

// Hashing de contraseñas (bcrypt). Se centraliza para poder cambiar el
// algoritmo/parámetros en un solo archivo (si mañana se migra a argon2,
// se toca solo esto). El coste viene de BCRYPT_ROUNDS.

/** Coste (rounds) embebido en el hash: `$2a$12$...` → 12. */
function costOf(hash: string): number | null {
  const match = /^\$2[abxy]\$(\d{2})\$/.exec(hash);
  return match ? Number(match[1]) : null;
}

export const PasswordService = {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
  },

  async verify(plain: string, hash: string | null | undefined): Promise<boolean> {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
  },

  /** ¿El hash guardado usa un coste distinto al configurado? */
  needsRehash(hash: string): boolean {
    const cost = costOf(hash);
    return cost !== null && cost !== env.BCRYPT_ROUNDS;
  },
};
