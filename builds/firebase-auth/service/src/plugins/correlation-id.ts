import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

const MAX_REQUEST_ID_LENGTH = 256;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

async function correlationId(app: FastifyInstance): Promise<void> {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const id =
      typeof incoming === 'string' &&
      incoming.length > 0 &&
      incoming.length <= MAX_REQUEST_ID_LENGTH &&
      PRINTABLE_ASCII.test(incoming)
        ? incoming
        : randomUUID();
    request.correlationId = id;
    reply.header('X-Request-ID', id);
  });
}

export default fp(correlationId, { name: 'correlation-id' });
