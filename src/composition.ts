import { db, withTransaction } from '@infra/database';
import { AuthService } from '@modules/auth/application/auth.service';
import { RefreshTokenIssuer, TokenService } from '@modules/auth/application/token.service';
import { PrismaAuthRepository } from '@modules/auth/infrastructure/PrismaAuthRepository';
import { logAudit } from '@modules/auditoria/auditoria.service';

// Composition root: único lugar donde se ensamblan dependencias. Los routers
// reciben lo que necesitan por inyección (nada de singletons globales).

export interface Container {
  tokens: TokenService;
  authService: AuthService;
}

export function buildContainer(): Container {
  const repo = new PrismaAuthRepository(db);
  const tokens = new TokenService();
  const authService = new AuthService({
    repo,
    tokens,
    refreshIssuer: RefreshTokenIssuer,
    audit: logAudit,
    withTransaction,
  });
  return { tokens, authService };
}