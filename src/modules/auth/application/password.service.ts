import bcrypt from 'bcryptjs';

// Hashing de contraseñas (bcrypt, cost 12). Se centraliza para poder cambiar
// el algoritmo/parámetros en un solo archivo (si mañana se migra a argon2,
// se toca solo esto).

const BCRYPT_ROUNDS = 12;

export const PasswordService = {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  },

  async verify(plain: string, hash: string | null | undefined): Promise<boolean> {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
  },
};