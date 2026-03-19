import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

/**
 * Request context plugin — onRequest hook.
 *
 * - Reads X-Request-ID from the incoming request header, or generates a UUIDv4.
 * - Decorates request.requestId with the correlation ID.
 * - Sets X-Request-ID on the response for downstream correlation.
 * - Creates a Pino child logger bound with { requestId } so every log line
 *   within the request lifecycle carries the correlation ID.
 *
 * Per ADR-005, this plugin is registered early (after log-redactor) so that
 * requestId is available to all subsequent hooks and route handlers.
 */
async function requestContextPlugin(app: FastifyInstance): Promise<void> {
  // Decorate with a default so Fastify knows the shape at startup
  app.decorateRequest('requestId', '');

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const headerValue = request.headers['x-request-id'];
    const id = typeof headerValue === 'string' && headerValue.length > 0
      ? headerValue
      : randomUUID();

    request.requestId = id;

    // Bind requestId to the Pino child logger for this request
    request.log = request.log.child({ requestId: id });

    // Echo the correlation ID back on the response
    void reply.header('x-request-id', id);

    done();
  });
}

export default fp(requestContextPlugin, { name: 'request-context' });
