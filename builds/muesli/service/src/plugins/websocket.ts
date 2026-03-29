import { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';

// ── Plugin ──────────────────────────────────────────────────────────

async function websocketPlugin(app: FastifyInstance): Promise<void> {
  await app.register(websocket);
}

export default fp(websocketPlugin, {
  name: 'websocket',
  fastify: '5.x',
});
