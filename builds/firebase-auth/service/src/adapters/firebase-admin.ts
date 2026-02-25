import {
  initializeApp,
  cert,
  applicationDefault,
  type App,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

let app: App | null = null;
let auth: Auth | null = null;

/**
 * Initialise the Firebase Admin SDK with a service account JSON credential.
 * This is the ONLY module that imports firebase-admin (ADR-001, REQ-006).
 *
 * Fails fast on invalid credential structure per ADR-004:
 * - JSON parse errors throw immediately
 * - cert() throws if projectId, clientEmail, or privateKey are missing
 */
export function initFirebase(credentialJson: string): void {
  if (app) {
    throw new Error('Firebase already initialised');
  }

  const serviceAccount: unknown = JSON.parse(credentialJson);

  app = initializeApp({
    credential: cert(serviceAccount as Parameters<typeof cert>[0]),
  });

  auth = getAuth(app);
}

/**
 * Initialise the Firebase Admin SDK using Application Default Credentials.
 * Used with Workload Identity Federation on Cloud Run (ADR-019).
 *
 * Eliminates long-lived SA JSON key material — the runtime identity is
 * provided by the GCP metadata server via ADC. Requires the Cloud Run
 * service account to have Firebase Auth permissions.
 */
export function initFirebaseWithADC(): void {
  if (app) {
    throw new Error('Firebase already initialised');
  }

  app = initializeApp({
    credential: applicationDefault(),
  });

  auth = getAuth(app);
}

/**
 * Initialise the Firebase Admin SDK for the Auth Emulator.
 * Uses a demo- prefixed project ID (Firebase convention for emulator-only).
 * No credential needed — the Admin SDK routes to the emulator automatically
 * when FIREBASE_AUTH_EMULATOR_HOST is set.
 */
export function initFirebaseForEmulator(): void {
  if (app) {
    throw new Error('Firebase already initialised');
  }
  app = initializeApp({ projectId: 'demo-firebase-auth' });
  auth = getAuth(app);
}

/**
 * Return the Auth instance created during init.
 * Throws if called before initFirebase() or initFirebaseWithADC() — fail-fast by design.
 */
export function getFirebaseAuth(): Auth {
  if (!auth) {
    throw new Error(
      'Firebase not initialised — call initFirebase() or initFirebaseWithADC() first',
    );
  }
  return auth;
}

// Re-export the Auth type so other modules import it from the adapter
// rather than from firebase-admin directly (REQ-006, ADR-001).
export type { Auth } from 'firebase-admin/auth';
