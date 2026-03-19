import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FirebaseAdapter, UserProfile } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = 'user-flows-key-001';
const KEY_ID = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID, Buffer.from(TEST_KEY)],
]);

const headers = { 'x-api-key': TEST_KEY };

function userProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: 'uid-flow-001',
    email: 'flow@example.com',
    emailVerified: false,
    displayName: 'Flow User',
    phoneNumber: null,
    photoURL: null,
    disabled: false,
    metadata: { creationTime: '2024-01-01T00:00:00Z', lastSignInTime: null, lastRefreshTime: null },
    customClaims: null,
    providerData: [],
    tokensValidAfterTime: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/infra/config.js', () => ({
  config: { apiKeys: fakeApiKeys },
}));

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function createMockAdapter(): FirebaseAdapter {
  return {
    projectId: 'test-project',
    isHealthy: () => true,
    shutdown: vi.fn(),
    verifyIdToken: vi.fn(),
    getUser: vi.fn().mockResolvedValue(userProfile()),
    getUserByEmail: vi.fn().mockResolvedValue(userProfile()),
    getUserByPhoneNumber: vi.fn().mockResolvedValue(userProfile()),
    getUsers: vi.fn().mockResolvedValue([userProfile()]),
    createUser: vi.fn().mockResolvedValue(userProfile()),
    updateUser: vi.fn().mockResolvedValue(userProfile({ displayName: 'Updated' })),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    deleteUsers: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0, errors: [] }),
    listUsers: vi.fn().mockResolvedValue({ users: [] }),
    setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    createCustomToken: vi.fn().mockResolvedValue(''),
    createSessionCookie: vi.fn().mockResolvedValue(''),
    verifySessionCookie: vi.fn(),
    generatePasswordResetLink: vi.fn().mockResolvedValue(''),
    generateEmailVerificationLink: vi.fn().mockResolvedValue(''),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue(''),
  } as unknown as FirebaseAdapter;
}

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

async function buildUserFlowsApp(adapter: FirebaseAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const { default: requestContext } = await import('../../src/plugins/request-context.js');
  const { default: errorHandler } = await import('../../src/plugins/error-handler.js');
  const { default: auditLogger } = await import('../../src/plugins/audit-logger.js');
  const { default: apiKeyAuth } = await import('../../src/plugins/api-key-auth.js');
  const { default: rateLimiter } = await import('../../src/plugins/rate-limiter.js');

  await app.register(requestContext);
  await app.register(errorHandler);
  await app.register(auditLogger);
  await app.register(apiKeyAuth);
  await app.register(rateLimiter, {
    config: { rateLimitRead: 1000, rateLimitMutation: 1000, rateLimitBatch: 1000 },
  });

  const { default: usersLookup } = await import('../../src/routes/users-lookup.js');
  const { default: usersMgmt } = await import('../../src/routes/users-management.js');
  const { default: healthRoute } = await import('../../src/routes/health.js');

  await app.register(healthRoute, { firebaseAdapter: adapter });
  await app.register(usersLookup, { firebaseAdapter: adapter });
  await app.register(usersMgmt, { firebaseAdapter: adapter });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user flows integration', () => {
  let app: FastifyInstance;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeAll(async () => {
    adapter = createMockAdapter();
    app = await buildUserFlowsApp(adapter);
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Full CRUD lifecycle
  // -----------------------------------------------------------------------

  it('creates a user (POST /users → 201)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/users', headers,
      payload: { email: 'flow@example.com', password: 'securepass' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().uid).toBe('uid-flow-001');
    expect(adapter.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'flow@example.com', password: 'securepass' }),
    );
  });

  it('reads a user by UID (GET /users/:uid → 200)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/users/uid-flow-001', headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().uid).toBe('uid-flow-001');
    expect(adapter.getUser).toHaveBeenCalledWith('uid-flow-001');
  });

  it('reads a user by email (GET /users/by-email/:email → 200)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/users/by-email/flow@example.com', headers,
    });

    expect(res.statusCode).toBe(200);
    expect(adapter.getUserByEmail).toHaveBeenCalledWith('flow@example.com');
  });

  it('updates a user (PATCH /users/:uid → 200)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/users/uid-flow-001', headers,
      payload: { displayName: 'Updated Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(adapter.updateUser).toHaveBeenCalledWith(
      'uid-flow-001',
      expect.objectContaining({ displayName: 'Updated Name' }),
    );
  });

  it('disables a user (POST /users/:uid/disable → 200)', async () => {
    vi.mocked(adapter.updateUser).mockResolvedValueOnce(userProfile({ disabled: true }));

    const res = await app.inject({
      method: 'POST', url: '/users/uid-flow-001/disable', headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().disabled).toBe(true);
    expect(adapter.updateUser).toHaveBeenCalledWith('uid-flow-001', { disabled: true });
  });

  it('enables a user (POST /users/:uid/enable → 200)', async () => {
    vi.mocked(adapter.updateUser).mockResolvedValueOnce(userProfile({ disabled: false }));

    const res = await app.inject({
      method: 'POST', url: '/users/uid-flow-001/enable', headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().disabled).toBe(false);
    expect(adapter.updateUser).toHaveBeenCalledWith('uid-flow-001', { disabled: false });
  });

  it('deletes a user (DELETE /users/:uid → 204)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/users/uid-flow-001', headers,
    });

    expect(res.statusCode).toBe(204);
    expect(adapter.deleteUser).toHaveBeenCalledWith('uid-flow-001');
  });

  // -----------------------------------------------------------------------
  // Batch lookup
  // -----------------------------------------------------------------------

  it('batch looks up users (POST /users/batch → 200)', async () => {
    vi.mocked(adapter.getUsers).mockResolvedValueOnce([userProfile()]);

    const res = await app.inject({
      method: 'POST', url: '/users/batch', headers,
      payload: { identifiers: [{ uid: 'uid-flow-001' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().users).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  it('rejects create with invalid email', async () => {
    const res = await app.inject({
      method: 'POST', url: '/users', headers,
      payload: { email: 'not-an-email', password: 'securepass' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects create with short password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/users', headers,
      payload: { email: 'test@example.com', password: '12345' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects update with no valid fields', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/users/uid-flow-001', headers,
      payload: { invalidField: 'value' },
    });
    expect(res.statusCode).toBe(400);
  });
});
