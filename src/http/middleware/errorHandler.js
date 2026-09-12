import { ZodError } from 'zod';
import logger from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `Ruta no encontrada: ${req.method} ${req.path}` } });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Datos inválidos',
        details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }

  // Prisma: registro no encontrado en update/delete
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: { code: 'not_found', message: 'El registro no existe' } });
  }
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: { code: 'conflict', message: 'Ya existe un registro con esos datos' } });
  }

  logger.error({ err, path: req.path, method: req.method }, 'Error no controlado');
  res.status(500).json({ error: { code: 'internal_error', message: 'Error interno del servidor' } });
}
