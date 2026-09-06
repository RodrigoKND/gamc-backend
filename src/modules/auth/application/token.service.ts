import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '@config/env';
import { sha256 } from '@shared/security';
import type { AccessTokenClaims, AuthSessionMetadata, PermissionsMap } from './auth.types.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'gamc-api';

// Firma y verificación de JWT de acceso con jose (usa Web Crypto: corre en
// Node y también en el middleware de Next.js). El payload NO es información
// sensible más allá del rol/permisos que la web ya conoce por su cuenta; lo
// crítico (refresh token) vive hasheado en BD.

export class TokenService {
  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setExpirationTime(`${env.ACCESS_TOKEN_MINUTES}m`)
      .sign(secret);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    return payload as unknown as AccessTokenClaims;
  }

  /** Permisos del rol embebidos en el claim `perms`, con forma { recurso: {ver,crear,editar,eliminar} }. */
  toClaims(input: {
    id: string;
    tipo: 'user' | 'guardia';
    rol: string;
    ident: string;
    nombre: string;
    permissions: PermissionsMap;
  }): AccessTokenClaims {
    return {
      sub: input.id,
      tipo: input.tipo,
      rol: input.rol,
      ident: input.ident,
      nombre: input.nombre,
      perms: input.permissions,
    };
  }
}

export interface RefreshTokenPair {
  token: string;
  hash: string;
  /** UUID en BD (columna uuid). Se hereda en la rotación para detectar reuso. */
  familia: string;
  /** UUID en BD (columna uuid). */
  id: string;
  expiraEn: Date;
}

// El TOKEN es opaco (base64url, 48 bytes) y solo se persiste su SHA-256;
// id/familia son UUIDs porque la BD los tipa como uuid.
export const RefreshTokenIssuer = {
  issue(metadata: AuthSessionMetadata, familia?: string): RefreshTokenPair {
    const token = randomBytes(48).toString('base64url');
    void metadata;
    return {
      token,
      hash: sha256(token),
      familia: familia ?? randomUUID(),
      id: randomUUID(),
      expiraEn: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    };
  },
};