/** Error de aplicación con código HTTP y código estable para el cliente. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'No autenticado') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'No autorizado') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'No encontrado') => new AppError(404, 'not_found', msg);
export const conflict = (code, msg, details) => new AppError(409, code, msg, details);
export const unprocessable = (code, msg, details) => new AppError(422, code, msg, details);
