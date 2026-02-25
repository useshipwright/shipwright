import type { FastifySchema } from 'fastify';

export const healthSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      required: ['status', 'firebase_initialized', 'version', 'timestamp'],
      properties: {
        status: { type: 'string', enum: ['healthy', 'degraded'] },
        firebase_initialized: { type: 'boolean' },
        version: { type: 'string' },
        timestamp: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};
