export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown;

  constructor(status: number, code: string, message: string, issues?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  toJSON() {
    const body: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.issues !== undefined) body.details = this.issues;
    return { error: body };
  }
}

type ErrorFactory = (message?: string, issues?: unknown) => AppError;

function of(status: number, code: string, message: string): ErrorFactory {
  return (msg, issues) => new AppError(status, code, msg ?? message, issues);
}

export const Errors = {
  validation: of(400, 'VALIDATION_ERROR', 'Datos de entrada inválidos.'),
  invalidCredentials: of(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas.'),
  auth: of(401, 'UNAUTHORIZED', 'No autorizado.'),
  accountDisabled: of(403, 'ACCOUNT_DISABLED', 'Cuenta deshabilitada.'),
  forbidden: of(403, 'FORBIDDEN', 'No tiene permisos para realizar esta acción.'),
  notFound: of(404, 'NOT_FOUND', 'Recurso no encontrado.'),
  conflict: of(409, 'CONFLICT', 'Conflicto con el estado actual del recurso.'),
  resetCodeInvalid: of(400, 'RESET_CODE_INVALID', 'Código de recuperación inválido.'),
  resetCodeExpired: of(400, 'RESET_CODE_EXPIRED', 'El código de recuperación expiró. Solicite uno nuevo.'),
  rateLimited: of(429, 'RATE_LIMITED', 'Demasiados intentos. Intente más tarde.'),
} satisfies Record<string, ErrorFactory>;