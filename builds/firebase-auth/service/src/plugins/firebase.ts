/**
 * Firebase plugin — ADR-004, ADR-019.
 *
 * Credential modes (checked in order):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON → SA JSON key via cert() (v1 default)
 *   2. FIREBASE_USE_ADC=true → Application Default Credentials (WIF, ADR-019)
 *   3. Neither → fail-fast (container won't start)
 *
 * Decorates the Fastify instance with firebaseAuth (the Auth object).
 * Route plugins depend on this decorator.
 *
 * Fail-fast strategy per ADR-004:
 * - Missing credential config → throws immediately (container won't start)
 * - cert() structural failure → adapter throws, propagated here
 * - Structurally valid but wrong key → init succeeds, runtime calls fail
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  initFirebase,
  initFirebaseWithADC,
  initFirebaseForEmulator,
  getFirebaseAuth,
} from '../adapters/firebase-admin.js';

async function firebase(app: FastifyInstance): Promise<void> {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) {
    initFirebaseForEmulator();
    app.log.info({ emulatorHost }, 'Firebase Admin SDK initialised in emulator mode');
    const auth = getFirebaseAuth();
    app.decorate('firebaseAuth', auth);
    return;
  }

  const credentialJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const useADC = process.env.FIREBASE_USE_ADC === 'true';

  if (!credentialJson && !useADC) {
    app.log.error(
      'No Firebase credential configured — set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_USE_ADC=true',
    );
    throw new Error(
      'Firebase credential required: set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_USE_ADC=true',
    );
  }

  try {
    if (credentialJson) {
      if (useADC) {
        app.log.warn(
          'Both FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_USE_ADC are set — using SA JSON key',
        );
      }
      initFirebase(credentialJson);
      app.log.info('Firebase Admin SDK initialised with SA JSON key');
    } else {
      initFirebaseWithADC();
      app.log.info(
        'Firebase Admin SDK initialised with Application Default Credentials (WIF)',
      );
    }

    const auth = getFirebaseAuth();
    app.decorate('firebaseAuth', auth);
  } catch (err) {
    app.log.error({ err }, 'Firebase Admin SDK initialisation failed');
    throw err;
  }
}

export default fp(firebase, {
  name: 'firebase',
  dependencies: ['@fastify/sensible'],
});
