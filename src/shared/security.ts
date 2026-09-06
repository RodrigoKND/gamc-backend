import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Primitivas de seguridad compartidas (sin estado, fáciles de testear):
// hashing de tokens en reposo, códigos de recuperación, contraseñas
// temporales y comparación en tiempo constante.

/** SHA-256 hex — para guardar refresh tokens / códigos en reposo (nunca el valor original). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Token aleatorio de alta entropía (base64url, sin padding) — refresh tokens. */
export function randomOpaqueToken(byteLength = 48): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Código de recuperación legible de N dígitos (6), para tipearlo en la web. */
export function randomResetCode(length = 6): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return String(randomInt(min, max));
}

/** Contraseña temporal legible de alta entropía (credenciales generadas). */
export function randomTemporaryPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Comparación en tiempo constante para códigos/secretos guiados por el usuario. */
export function constantTimeEqual(a: string, b: string): boolean {
  const hashedA = createHash('sha256').update(a).digest();
  const hashedB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashedA, hashedB);
}

/** Token CSRF de doble envío (cookie no httpOnly + header, validados en sericio). */
export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}