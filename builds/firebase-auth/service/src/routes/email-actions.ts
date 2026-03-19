import { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { ActionCodeSettings, FirebaseAdapter } from '../domain/types.js';
import { validateEmail } from '../domain/validators.js';

export interface EmailActionRouteOptions {
  firebaseAdapter: FirebaseAdapter;
}

const emailActionRoutes: FastifyPluginAsync<EmailActionRouteOptions> = async (
  app: FastifyInstance,
  opts: EmailActionRouteOptions,
) => {
  const { firebaseAdapter } = opts;

  // ---------------------------------------------------------------------------
  // POST /email-actions/password-reset
  // ---------------------------------------------------------------------------

  app.post('/email-actions/password-reset', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { email, actionCodeSettings } = body as {
      email?: string;
      actionCodeSettings?: ActionCodeSettings;
    };

    if (!email || typeof email !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: email',
          requestId: request.requestId ?? '',
        },
      });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: emailValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    const link = await firebaseAdapter.generatePasswordResetLink(
      email,
      actionCodeSettings,
    );

    return reply.status(200).send({ link });
  });

  // ---------------------------------------------------------------------------
  // POST /email-actions/verification
  // ---------------------------------------------------------------------------

  app.post('/email-actions/verification', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { email, actionCodeSettings } = body as {
      email?: string;
      actionCodeSettings?: ActionCodeSettings;
    };

    if (!email || typeof email !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: email',
          requestId: request.requestId ?? '',
        },
      });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: emailValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    const link = await firebaseAdapter.generateEmailVerificationLink(
      email,
      actionCodeSettings,
    );

    return reply.status(200).send({ link });
  });

  // ---------------------------------------------------------------------------
  // POST /email-actions/sign-in
  // ---------------------------------------------------------------------------

  app.post('/email-actions/sign-in', {
    config: { rateLimitClasses: ['mutation'] },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { email, actionCodeSettings } = body as {
      email?: string;
      actionCodeSettings?: ActionCodeSettings;
    };

    if (!email || typeof email !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: email',
          requestId: request.requestId ?? '',
        },
      });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: emailValidation.error!,
          requestId: request.requestId ?? '',
        },
      });
    }

    if (!actionCodeSettings || typeof actionCodeSettings !== 'object') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'Missing required field: actionCodeSettings',
          requestId: request.requestId ?? '',
        },
      });
    }

    if (!actionCodeSettings.url || typeof actionCodeSettings.url !== 'string') {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'actionCodeSettings.url is required',
          requestId: request.requestId ?? '',
        },
      });
    }

    if (actionCodeSettings.handleCodeInApp !== true) {
      return reply.status(400).send({
        error: {
          code: 400,
          message: 'actionCodeSettings.handleCodeInApp must be true',
          requestId: request.requestId ?? '',
        },
      });
    }

    const link = await firebaseAdapter.generateSignInWithEmailLink(
      email,
      actionCodeSettings,
    );

    return reply.status(200).send({ link });
  });
};

export default emailActionRoutes;
