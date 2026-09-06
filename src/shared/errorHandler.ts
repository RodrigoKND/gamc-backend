import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { logger } from '@infra/logger';
import { AppError } from './AppError.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.status).json(err.toJSON());
    return;
  }

  if ((err as { name?: string })?.name === 'ZodError') {
    const zod = err as ZodError;
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Datos de entrada inválidos.',
        details: zod.issues,
      },
    });
    return;
  }

  logger.error({ err, msg: 'error no controlado' });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' },
  });
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'La ruta solicitada no existe.' },
  });
};