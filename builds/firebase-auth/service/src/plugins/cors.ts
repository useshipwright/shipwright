import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

async function corsPlugin(app: FastifyInstance): Promise<void> {
  if (!process.env.CORS_ORIGIN && process.env.NODE_ENV === 'production') {
    app.log.warn('CORS_ORIGIN is not set; allowing all origins in production');
  }
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
  });
}

export default fp(corsPlugin, { name: 'cors' });
