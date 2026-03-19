import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { FirebaseAdapter, UserProfile } from '../../src/domain/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_KEY = 'audit-log-key-001';
const KEY_ID = createHash('sha256').update(TEST_KEY).digest('hex').slice(0, 8);

const fakeApiKeys: ReadonlyMap<string, Buffer> = new Map([
  [KEY_ID, Buffer.from(TEST_KEY)],
]);

const headers = { 'x-api-key': TEST_KEY };

const userFixture: UserProfile = {
  uid: 'uid-audit-001',
  email: 'audit@example.com',
  emailVerified: true,
  displayName: 'Audit User',
  phoneNumber: null,
  photoURL: null,
  disabled: false,
  metadata: { creationTime: '2024-01-01T00:00:00Z', lastSignInTime: null, lastRefreshTime: null },
  customClaims: null,
  providerData: [],
  tokensValidAfterTime: '2024-06-01T00:00:00Z',
};

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
    getUser: vi.fn().mockResolvedValue(userFixture),
    getUserByEmail: vi.fn(),
    getUserByPhoneNumber: vi.fn(),
    getUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn().mockResolvedValue(userFixture),
    updateUser: vi.fn().mockResolvedValue(userFixture),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    deleteUsers: vi.fn().mockResolvedValue({ successCount: 2, failureCount: 0, errors: [] }),
    listUsers: vi.fn().mockResolvedValue({ users: [] }),
    setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    createCustomToken: vi.fn().mockResolvedValue('tok'),
    createSessionCookie: vi.fn().mockResolvedValue('cookie'),
    verifySessionCookie: vi.fn(),
    generatePasswordResetLink: vi.fn().mockResolvedValue(''),
    generateEmailVerificationLink: vi.fn().mockResolvedValue(''),
    generateSignInWithEmailLink: vi.fn().mockResolvedValue(''),
  } as unknown as FirebaseAdapter;
}

// ---------------------------------------------------------------------------
// Build app with audit spy
// ---------------------------------------------------------------------------

async function buildAuditApp(adapter: FirebaseAdapter): Promise<{
  app: FastifyInstance;
  auditSpy: ReturnType<typeof vi.fn>;
}> {
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

  const { default: usersMgmt } = await import('../../src/routes/users-management.js');
  const { default: claimsRoutes } = await import('../../src/routes/claims.js');
  const { default: tokenRoutes } = await import('../../src/routes/tokens.js');
  const { default: batchOps } = await import('../../src/routes/batch-operations.js');

  await app.register(usersMgmt, { firebaseAdapter: adapter });
  await app.register(claimsRoutes, { firebaseAdapter: adapter });
  await app.register(tokenRoutes, { firebaseAdapter: adapter });
  await app.register(batchOps, { firebaseAdapter: adapter });

  await app.ready();

  // Spy on emitAudit after app is ready (decorator is set)
  const auditSpy = vi.fn(app.emitAudit.bind(app));
  app.emitAudit = auditSpy;

  return { app, auditSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit logging integration', () => {
  let app: FastifyInstance;
  let adapter: ReturnType<typeof createMockAdapter>;
  let auditSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    adapter = createMockAdapter();
    const result = await buildAuditApp(adapter);
    app = result.app;
    auditSpy = result.auditSpy;
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // User management audit events
  // -----------------------------------------------------------------------

  it('emits user.created audit on POST /users', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'POST', url: '/users', headers,
      payload: { email: 'audit@example.com', password: 'securepass' },
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('user.created');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toContain('email');
    expect(entry.changes.fields).toContain('password');
  });

  it('emits user.updated audit on PATCH /users/:uid', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'PATCH', url: '/users/uid-audit-001', headers,
      payload: { displayName: 'New Name' },
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('user.updated');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toContain('displayName');
  });

  it('emits user.deleted audit on DELETE /users/:uid', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'DELETE', url: '/users/uid-audit-001', headers,
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('user.deleted');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toEqual([]);
  });

  it('emits user.disabled audit on POST /users/:uid/disable', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'POST', url: '/users/uid-audit-001/disable', headers,
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('user.disabled');
    expect(entry.changes.fields).toContain('disabled');
  });

  it('emits user.enabled audit on POST /users/:uid/enable', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'POST', url: '/users/uid-audit-001/enable', headers,
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('user.enabled');
    expect(entry.changes.fields).toContain('disabled');
  });

  // -----------------------------------------------------------------------
  // Custom claims audit events
  // -----------------------------------------------------------------------

  it('emits claims.set audit on PUT /users/:uid/claims', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'PUT', url: '/users/uid-audit-001/claims', headers,
      payload: { claims: { role: 'admin', level: 5 } },
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('claims.set');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toContain('role');
    expect(entry.changes.fields).toContain('level');
  });

  it('emits claims.deleted audit on DELETE /users/:uid/claims', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'DELETE', url: '/users/uid-audit-001/claims', headers,
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('claims.deleted');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Token revocation audit events
  // -----------------------------------------------------------------------

  it('emits tokens.revoked audit on POST /users/:uid/revoke', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'POST', url: '/users/uid-audit-001/revoke', headers,
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('tokens.revoked');
    expect(entry.target).toBe('uid-audit-001');
    expect(entry.changes.fields).toContain('refreshTokens');
  });

  // -----------------------------------------------------------------------
  // Batch operations audit events
  // -----------------------------------------------------------------------

  it('emits users.batch_deleted audit on POST /users/batch-delete', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'POST', url: '/users/batch-delete', headers,
      payload: { uids: ['uid-1', 'uid-2'] },
    });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, entry] = auditSpy.mock.calls[0];
    expect(entry.event).toBe('users.batch_deleted');
    expect(entry.changes.fields).toContain('uids');
  });

  // -----------------------------------------------------------------------
  // Audit entry structure
  // -----------------------------------------------------------------------

  it('audit entries contain event, target, and changes.fields (no values)', async () => {
    auditSpy.mockClear();

    await app.inject({
      method: 'PATCH', url: '/users/uid-audit-001', headers,
      payload: { email: 'new@example.com', displayName: 'New' },
    });

    const [, entry] = auditSpy.mock.calls[0];
    expect(entry).toHaveProperty('event');
    expect(entry).toHaveProperty('target');
    expect(entry).toHaveProperty('changes');
    expect(entry.changes).toHaveProperty('fields');
    expect(Array.isArray(entry.changes.fields)).toBe(true);
    // Fields are names only — no values in the audit entry
    for (const field of entry.changes.fields) {
      expect(typeof field).toBe('string');
    }
  });

  it('does NOT emit audit on read operations', async () => {
    auditSpy.mockClear();

    // GET /users is a read operation — should not trigger emitAudit
    // (batch-operations registers GET /users, which is a read route)
    await app.inject({
      method: 'GET', url: '/users', headers,
    });

    expect(auditSpy).not.toHaveBeenCalled();
  });
});
