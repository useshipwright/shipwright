import { type FastifyError, type FastifyInstance } from 'fastify';

/**
 * Standard error response shape — consistent across all endpoints.
 * Template contract: every stack template provides this same interface.
 */
export interface AppError {
  statusCode: number;
  error: string;
  message: string;
}

export function createAppError(
  statusCode: number,
  message: string,
): AppError {
  const errorNames: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    500: 'Internal Server Error',
  };
  return {
    statusCode,
    error: errorNames[statusCode] ?? 'Error',
    message,
  };
}

/**
 * Register the global error handler. Call once in buildApp().
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? 'Internal Server Error' : error.message;

    app.log.error({ err: error, statusCode }, 'Request error');

    reply.status(statusCode).send(createAppError(statusCode, message));
  });
}
