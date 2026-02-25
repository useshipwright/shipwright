import type { Auth } from 'firebase-admin/auth';

declare module 'fastify' {
  interface FastifyInstance {
    firebaseAuth: Auth;
  }
  interface FastifyRequest {
    correlationId: string;
  }
}
