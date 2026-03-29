import { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';

// ── Constants ───────────────────────────────────────────────────────

/** 500 MB file-size limit per the pack contract. */
const FILE_SIZE_LIMIT = 500 * 1024 * 1024;

// ── Plugin ──────────────────────────────────────────────────────────

async function multipartPlugin(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: FILE_SIZE_LIMIT,
    },
  });
}

export default fp(multipartPlugin, {
  name: 'multipart',
  fastify: '5.x',
});
