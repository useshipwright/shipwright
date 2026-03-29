import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { initializeApp, cert, getApps, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Share } from '../types/domain.js';
import type { ApiErrorResponse } from '../types/api.js';

// ── Fastify Type Augmentation ───────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
  }
}

// ── Constants ───────────────────────────────────────────────────────

/** Paths that bypass auth entirely. */
const NO_AUTH_PATHS = new Set(['/health', '/health/ready', '/metrics']);

/** Standard 401 error envelope. */
function unauthorizedResponse(message: string): ApiErrorResponse {
  return { error: { code: 401, message } };
}

/** Standard 403 error envelope. */
function forbiddenResponse(message: string): ApiErrorResponse {
  return { error: { code: 403, message } };
}

// ── Firebase Initialization ─────────────────────────────────────────

let firebaseApp: App | undefined;

function getFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;

  const existing = getApps();
  if (existing.length > 0) {
    firebaseApp = existing[0];
    return firebaseApp;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const serviceAccount = JSON.parse(raw) as ServiceAccount;
    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  } else {
    // Fall back to Application Default Credentials (Cloud Run, emulators)
    firebaseApp = initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  }
  return firebaseApp;
}

// ── Token Verification Helpers ──────────────────────────────────────

async function verifyFirebaseToken(
  token: string,
): Promise<{ userId: string; email: string } | null> {
  try {
    const app = getFirebaseApp();
    const decoded = await getAuth(app).verifyIdToken(token);
    return {
      userId: decoded.uid,
      email: decoded.email ?? '',
    };
  } catch (err) {
    console.error('Firebase token verification failed:', (err as Error).message);
    return null;
  }
}

/**
 * Verify Pub/Sub OIDC token for /internal/* routes.
 * Validates the token is a Google-signed OIDC JWT issued for the expected
 * service account identity.
 */
async function verifyOidcToken(
  token: string,
  expectedEmail?: string,
): Promise<boolean> {
  try {
    // Cryptographically verify the OIDC token against Google's public keys
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({
      idToken: token,
      // audience is not checked here -- Pub/Sub tokens have the service URL as audience
    });
    const payload = ticket.getPayload();
    if (!payload) return false;

    // If an expected email is provided, verify it matches
    if (expectedEmail && payload.email !== expectedEmail) return false;

    return true;
  } catch {
    return false;
  }
}

// ── Share Access Verification ───────────────────────────────────────

/**
 * Enforce share-specific access control rules.
 * - public: no auth required
 * - authenticated: any valid Firebase JWT
 * - specific_emails: valid JWT + email must be in allowedEmails + email_verified
 */
async function verifyShareAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  share: Share | null,
): Promise<boolean> {
  if (!share) {
    // Return 404 for non-existent, expired, or revoked shares — identical response
    reply.code(404).send({ error: { code: 404, message: 'Share not found' } });
    return false;
  }

  // Check expiration
  if (share.expiresAt && share.expiresAt < new Date()) {
    reply.code(404).send({ error: { code: 404, message: 'Share not found' } });
    return false;
  }

  switch (share.accessMode) {
    case 'public':
      // No auth needed — set empty userId/email
      request.userId = '';
      request.userEmail = '';
      return true;

    case 'authenticated': {
      const authResult = await extractAndVerifyBearer(request);
      if (!authResult) {
        reply.code(401).send(unauthorizedResponse('Authentication required'));
        return false;
      }
      request.userId = authResult.userId;
      request.userEmail = authResult.email;
      return true;
    }

    case 'specific_emails': {
      const authResult = await extractAndVerifyBearer(request);
      if (!authResult) {
        reply.code(401).send(unauthorizedResponse('Authentication required'));
        return false;
      }

      // Verify email_verified claim
      const app = getFirebaseApp();
      const decoded = await getAuth(app).verifyIdToken(
        extractBearerToken(request) ?? '',
      );
      if (!decoded.email_verified) {
        reply.code(403).send(forbiddenResponse('Email verification required'));
        return false;
      }

      // Check if email is in the allowed list
      if (
        !share.allowedEmails ||
        !share.allowedEmails.includes(authResult.email)
      ) {
        // Return 404 — no information leakage about whether the share exists
        reply.code(404).send({ error: { code: 404, message: 'Share not found' } });
        return false;
      }

      request.userId = authResult.userId;
      request.userEmail = authResult.email;
      return true;
    }

    default:
      reply.code(404).send({ error: { code: 404, message: 'Share not found' } });
      return false;
  }
}

// ── Token Extraction ────────────────────────────────────────────────

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

async function extractAndVerifyBearer(
  request: FastifyRequest,
): Promise<{ userId: string; email: string } | null> {
  const token = extractBearerToken(request);
  if (!token) return null;
  return verifyFirebaseToken(token);
}

// ── Plugin ──────────────────────────────────────────────────────────

async function authPlugin(app: FastifyInstance): Promise<void> {
  // Decorate request with userId and userEmail defaults
  app.decorateRequest('userId', '');
  app.decorateRequest('userEmail', '');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0]; // Strip query params for matching

    // Skip auth for health/metrics endpoints
    if (NO_AUTH_PATHS.has(url)) return;

    // ── Share routes: /api/share/:shareId ──────────────────────────
    if (url.startsWith('/api/share/')) {
      // DELETE requires full Bearer auth (only owner can revoke)
      if (request.method === 'DELETE') {
        const result = await extractAndVerifyBearer(request);
        if (!result) {
          reply.code(401).send(unauthorizedResponse);
          return;
        }
        request.userId = result.userId;
        request.userEmail = result.email;
        return;
      }

      const shareId = url.slice('/api/share/'.length);
      if (!shareId) {
        reply.code(404).send({ error: { code: 404, message: 'Share not found' } });
        return;
      }

      // Look up the share via the Firestore adapter on the app instance
      const firestoreAdapter = (app as unknown as Record<string, unknown>)['firestoreAdapter'] as
        | { getShare(shareId: string): Promise<Share | null> }
        | undefined;

      if (firestoreAdapter) {
        const share = await firestoreAdapter.getShare(shareId);
        const allowed = await verifyShareAccess(request, reply, share);
        if (!allowed) return;
      }
      return;
    }

    // ── Internal routes: /internal/* ──────────────────────────────
    if (url.startsWith('/internal/')) {
      const token = extractBearerToken(request);
      if (!token) {
        reply.code(401).send(unauthorizedResponse('OIDC token required'));
        return;
      }

      const valid = await verifyOidcToken(token);
      if (!valid) {
        reply.code(401).send(unauthorizedResponse('Invalid OIDC token'));
        return;
      }

      // Internal routes don't set userId/userEmail — they operate on behalf of the system
      return;
    }

    // ── API routes: /api/* ────────────────────────────────────────
    if (url.startsWith('/api/')) {
      const authResult = await extractAndVerifyBearer(request);
      if (!authResult) {
        reply.code(401).send(unauthorizedResponse('Valid authentication token required'));
        return;
      }

      request.userId = authResult.userId;
      request.userEmail = authResult.email;
      return;
    }

    // All other routes pass through (e.g. root, docs)
  });
}

export default fp(authPlugin, { name: 'auth' });
