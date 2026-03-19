import { initializeApp, cert, deleteApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

import { config } from './config.js';
import type {
  FirebaseAdapter,
  UserProfile,
  DecodedToken,
  DeleteUsersResult,
  ListUsersResult,
  ActionCodeSettings,
  UserIdentifier,
} from '../domain/types.js';

// ---------------------------------------------------------------------------
// Mapping helpers — SDK types → domain types
// ---------------------------------------------------------------------------

function toUserProfile(rec: import('firebase-admin/auth').UserRecord): UserProfile {
  return {
    uid: rec.uid,
    email: rec.email ?? null,
    emailVerified: rec.emailVerified,
    displayName: rec.displayName ?? null,
    phoneNumber: rec.phoneNumber ?? null,
    photoURL: rec.photoURL ?? null,
    disabled: rec.disabled,
    metadata: {
      creationTime: rec.metadata.creationTime,
      lastSignInTime: rec.metadata.lastSignInTime ?? null,
      lastRefreshTime: rec.metadata.lastRefreshTime ?? null,
    },
    customClaims: (rec.customClaims as Record<string, unknown>) ?? null,
    providerData: rec.providerData.map((p) => ({
      uid: p.uid,
      providerId: p.providerId,
      email: p.email,
      displayName: p.displayName,
      photoURL: p.photoURL,
      phoneNumber: p.phoneNumber,
    })),
    tokensValidAfterTime: rec.tokensValidAfterTime ?? null,
  };
}

function toDecodedToken(t: import('firebase-admin/auth').DecodedIdToken): DecodedToken {
  // Extract custom claims: everything except standard JWT / Firebase fields
  const standardKeys = new Set([
    'aud', 'auth_time', 'email', 'email_verified', 'exp', 'firebase',
    'iat', 'iss', 'phone_number', 'picture', 'sub', 'uid', 'user_id',
  ]);
  const claims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (!standardKeys.has(k)) {
      claims[k] = v;
    }
  }

  return {
    uid: t.uid,
    email: t.email ?? null,
    emailVerified: t.email_verified ?? false,
    claims,
    iss: t.iss,
    aud: t.aud,
    iat: t.iat,
    exp: t.exp,
    auth_time: t.auth_time,
  };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

function createAdapter(
  app: App, auth: Auth, extractedProjectId: string,
): { adapter: FirebaseAdapter; setHealthy: () => void } {
  let healthy = false;
  let shutdownCalled = false;

  const adapter: FirebaseAdapter = {
    get projectId(): string {
      return extractedProjectId;
    },

    isHealthy(): boolean {
      return healthy;
    },

    async shutdown(): Promise<void> {
      if (shutdownCalled) return;
      shutdownCalled = true;
      healthy = false;
      try {
        await deleteApp(app);
      } catch {
        // Swallow errors -- shutdown must be safe to call multiple times
      }
    },

    // -- Token verification --------------------------------------------------

    async verifyIdToken(token: string, checkRevoked?: boolean): Promise<DecodedToken> {
      const decoded = await auth.verifyIdToken(token, checkRevoked);
      return toDecodedToken(decoded);
    },

    // -- User lookup ---------------------------------------------------------

    async getUser(uid: string): Promise<UserProfile> {
      const rec = await auth.getUser(uid);
      return toUserProfile(rec);
    },

    async getUserByEmail(email: string): Promise<UserProfile> {
      const rec = await auth.getUserByEmail(email);
      return toUserProfile(rec);
    },

    async getUserByPhoneNumber(phoneNumber: string): Promise<UserProfile> {
      const rec = await auth.getUserByPhoneNumber(phoneNumber);
      return toUserProfile(rec);
    },

    async getUsers(identifiers: readonly UserIdentifier[]): Promise<readonly UserProfile[]> {
      // SDK expects mutable array; our interface is readonly
      const result = await auth.getUsers(
        identifiers as import('firebase-admin/auth').UserIdentifier[],
      );
      return result.users.map(toUserProfile);
    },

    // -- User management -----------------------------------------------------

    async createUser(properties: Record<string, unknown>): Promise<UserProfile> {
      const rec = await auth.createUser(
        properties as import('firebase-admin/auth').CreateRequest,
      );
      return toUserProfile(rec);
    },

    async updateUser(uid: string, properties: Record<string, unknown>): Promise<UserProfile> {
      const rec = await auth.updateUser(
        uid,
        properties as import('firebase-admin/auth').UpdateRequest,
      );
      return toUserProfile(rec);
    },

    async deleteUser(uid: string): Promise<void> {
      await auth.deleteUser(uid);
    },

    async deleteUsers(uids: readonly string[]): Promise<DeleteUsersResult> {
      const result = await auth.deleteUsers(uids as string[]);
      return {
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors: result.errors.map((e) => ({
          index: e.index,
          error: { code: String(e.error.code), message: e.error.message },
        })),
      };
    },

    // -- User listing --------------------------------------------------------

    async listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
      const result = await auth.listUsers(maxResults, pageToken);
      return {
        users: result.users.map(toUserProfile),
        pageToken: result.pageToken,
      };
    },

    // -- Custom claims -------------------------------------------------------

    async setCustomUserClaims(uid: string, claims: Record<string, unknown> | null): Promise<void> {
      await auth.setCustomUserClaims(uid, claims);
    },

    // -- Token operations ----------------------------------------------------

    async revokeRefreshTokens(uid: string): Promise<void> {
      await auth.revokeRefreshTokens(uid);
    },

    async createCustomToken(uid: string, claims?: Record<string, unknown>): Promise<string> {
      return auth.createCustomToken(uid, claims);
    },

    // -- Session cookies -----------------------------------------------------

    async createSessionCookie(idToken: string, expiresIn: number): Promise<string> {
      return auth.createSessionCookie(idToken, { expiresIn });
    },

    async verifySessionCookie(cookie: string, checkRevoked?: boolean): Promise<DecodedToken> {
      const decoded = await auth.verifySessionCookie(cookie, checkRevoked);
      return toDecodedToken(decoded);
    },

    // -- Email action links --------------------------------------------------

    async generatePasswordResetLink(
      email: string,
      actionCodeSettings?: ActionCodeSettings,
    ): Promise<string> {
      return auth.generatePasswordResetLink(email, actionCodeSettings);
    },

    async generateEmailVerificationLink(
      email: string,
      actionCodeSettings?: ActionCodeSettings,
    ): Promise<string> {
      return auth.generateEmailVerificationLink(email, actionCodeSettings);
    },

    async generateSignInWithEmailLink(
      email: string,
      actionCodeSettings: ActionCodeSettings,
    ): Promise<string> {
      return auth.generateSignInWithEmailLink(email, actionCodeSettings);
    },
  };

  // Expose a way for initializeAndProbe to mark healthy after probe passes
  const setHealthy = () => { healthy = true; };
  return { adapter, setHealthy };
}

// ---------------------------------------------------------------------------
// Initialization + health probe (ADR-004)
// ---------------------------------------------------------------------------

const HEALTH_PROBE_UID = '__firebase_adapter_health_probe__';

async function initializeAndProbe(): Promise<FirebaseAdapter> {
  // Skip Firebase initialization for container-level smoke testing.
  // When set, returns a stub adapter that reports unhealthy but allows
  // the server to start and serve /health, /metrics, etc.
  if (config.skipFirebaseHealthProbe) {
    const notInit = (): never => {
      throw new Error('Firebase not initialized (SKIP_FIREBASE_HEALTH_PROBE=true)');
    };
    return {
      get projectId() { return 'smoke-test-stub'; },
      isHealthy: () => false,
      shutdown: async () => {},
      verifyIdToken: notInit,
      getUser: notInit,
      getUserByEmail: notInit,
      getUserByPhoneNumber: notInit,
      getUsers: notInit,
      createUser: notInit,
      updateUser: notInit,
      deleteUser: notInit,
      deleteUsers: notInit,
      listUsers: notInit,
      setCustomUserClaims: notInit,
      revokeRefreshTokens: notInit,
      createCustomToken: notInit,
      createSessionCookie: notInit,
      verifySessionCookie: notInit,
      generatePasswordResetLink: notInit,
      generateEmailVerificationLink: notInit,
      generateSignInWithEmailLink: notInit,
    } as unknown as FirebaseAdapter;
  }

  const credential = cert(
    config.serviceAccountCredential as import('firebase-admin/app').ServiceAccount,
  );

  const projectId =
    (config.serviceAccountCredential as Record<string, unknown>).project_id as string | undefined;

  if (!projectId) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is missing "project_id". Cannot initialize Firebase Admin SDK.',
    );
  }

  const app: App = initializeApp({ credential, projectId });
  const auth: Auth = getAuth(app);

  const { adapter, setHealthy } = createAdapter(app, auth, projectId);

  // Startup health probe per ADR-004:
  // Call getUser with a nonexistent UID -- expect auth/user-not-found.
  // Any other error means bad credentials or misconfiguration -- fail fast.
  try {
    await auth.getUser(HEALTH_PROBE_UID);
    // If the user somehow exists, the SDK is working
    setHealthy();
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/user-not-found') {
      // Expected -- SDK is correctly initialized
      setHealthy();
    } else {
      throw new Error(
        `Firebase Admin SDK health probe failed: ${code ?? 'unknown error'}. ` +
          'Verify FIREBASE_SERVICE_ACCOUNT_JSON contains valid credentials. ' +
          `Details: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return adapter;
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const firebaseAdapterReady: Promise<FirebaseAdapter> = initializeAndProbe();
