import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Helper para handlers async de Express sin try/catch repetido: cualquier
// AppError lanzado viaja al errorHandler central.

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}