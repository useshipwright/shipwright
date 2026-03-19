import { describe, it, expect } from 'vitest';
import type {
  RateLimitClass,
  RouteMetadata,
  UserMetadata,
  ProviderUserInfo,
  UserProfile,
  DecodedToken,
  BatchVerifyTokenResult,
  BatchVerifySummary,
  BatchVerifyResult,
  AuditEntry,
  ErrorResponse,
  UserIdentifier,
  DeleteUsersResult,
  ListUsersResult,
  ActionCodeSettings,
  FirebaseAdapter,
} from '../../src/domain/types.js';

/**
 * Type-level tests: these verify that the exported types are importable
 * and that conforming objects have the expected structural shape at runtime.
 * TypeScript compilation catches type errors; runtime checks verify structure.
 */

describe('domain/types exports', () => {
  // -----------------------------------------------------------------------
  // RateLimitClass
  // -----------------------------------------------------------------------

  it('RateLimitClass accepts valid string literals', () => {
    const values: RateLimitClass[] = ['read', 'mutation', 'batch'];
    expect(values).toHaveLength(3);
    expect(values).toContain('read');
    expect(values).toContain('mutation');
    expect(values).toContain('batch');
  });

  // -----------------------------------------------------------------------
  // RouteMetadata
  // -----------------------------------------------------------------------

  it('RouteMetadata has rateLimitClasses', () => {
    const meta: RouteMetadata = { rateLimitClasses: ['read', 'batch'] };
    expect(meta.rateLimitClasses).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // UserMetadata
  // -----------------------------------------------------------------------

  it('UserMetadata has expected properties', () => {
    const meta: UserMetadata = {
      creationTime: '2024-01-01T00:00:00Z',
      lastSignInTime: '2024-01-02T00:00:00Z',
      lastRefreshTime: null,
    };
    expect(meta).toHaveProperty('creationTime');
    expect(meta).toHaveProperty('lastSignInTime');
    expect(meta).toHaveProperty('lastRefreshTime');
  });

  // -----------------------------------------------------------------------
  // ProviderUserInfo
  // -----------------------------------------------------------------------

  it('ProviderUserInfo has required and optional properties', () => {
    const info: ProviderUserInfo = {
      uid: 'provider-uid',
      providerId: 'google.com',
    };
    expect(info.uid).toBe('provider-uid');
    expect(info.providerId).toBe('google.com');
    expect(info.email).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // UserProfile
  // -----------------------------------------------------------------------

  it('UserProfile has all expected fields', () => {
    const profile: UserProfile = {
      uid: 'u1',
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'User One',
      phoneNumber: '+14155552671',
      photoURL: null,
      disabled: false,
      metadata: {
        creationTime: '2024-01-01T00:00:00Z',
        lastSignInTime: null,
        lastRefreshTime: null,
      },
      customClaims: { role: 'admin' },
      providerData: [],
      tokensValidAfterTime: null,
    };

    expect(profile.uid).toBe('u1');
    expect(profile.metadata).toHaveProperty('creationTime');
    expect(profile.providerData).toEqual([]);
    expect(profile.customClaims).toEqual({ role: 'admin' });
  });

  it('UserProfile allows null for optional fields', () => {
    const profile: UserProfile = {
      uid: 'u2',
      email: null,
      emailVerified: false,
      displayName: null,
      phoneNumber: null,
      photoURL: null,
      disabled: false,
      metadata: {
        creationTime: '2024-01-01T00:00:00Z',
        lastSignInTime: null,
        lastRefreshTime: null,
      },
      customClaims: null,
      providerData: [],
      tokensValidAfterTime: null,
    };

    expect(profile.email).toBeNull();
    expect(profile.customClaims).toBeNull();
  });

  // -----------------------------------------------------------------------
  // DecodedToken
  // -----------------------------------------------------------------------

  it('DecodedToken has all expected fields', () => {
    const token: DecodedToken = {
      uid: 'u1',
      email: 'user@example.com',
      emailVerified: true,
      claims: { role: 'admin' },
      iss: 'https://securetoken.google.com/test-project',
      aud: 'test-project',
      iat: 1700000000,
      exp: 1700003600,
      auth_time: 1700000000,
    };

    expect(token.uid).toBe('u1');
    expect(token.claims).toHaveProperty('role');
    expect(token.iss).toContain('securetoken.google.com');
    expect(typeof token.iat).toBe('number');
    expect(typeof token.exp).toBe('number');
  });

  // -----------------------------------------------------------------------
  // BatchVerifyResult
  // -----------------------------------------------------------------------

  it('BatchVerifyResult has results and summary', () => {
    const tokenResult: BatchVerifyTokenResult = {
      valid: true,
      uid: 'u1',
      email: 'user@example.com',
      claims: {},
    };
    const invalidResult: BatchVerifyTokenResult = {
      valid: false,
      error: 'Token expired',
    };
    const summary: BatchVerifySummary = { total: 2, valid: 1, invalid: 1 };
    const batch: BatchVerifyResult = {
      results: [tokenResult, invalidResult],
      summary,
    };

    expect(batch.results).toHaveLength(2);
    expect(batch.summary.total).toBe(2);
    expect(batch.results[0].valid).toBe(true);
    expect(batch.results[1].valid).toBe(false);
    expect(batch.results[1].error).toBe('Token expired');
  });

  // -----------------------------------------------------------------------
  // AuditEntry
  // -----------------------------------------------------------------------

  it('AuditEntry has event, target, and changes.fields', () => {
    const entry: AuditEntry = {
      event: 'user.created',
      target: 'uid-123',
      changes: { fields: ['email', 'displayName'] },
    };

    expect(entry.event).toBe('user.created');
    expect(entry.changes.fields).toContain('email');
    expect(entry.changes.fields).not.toContain('password');
  });

  // -----------------------------------------------------------------------
  // ErrorResponse
  // -----------------------------------------------------------------------

  it('ErrorResponse has error envelope with code, message, requestId', () => {
    const resp: ErrorResponse = {
      error: {
        code: 404,
        message: 'User not found',
        requestId: 'req-abc-123',
      },
    };

    expect(resp.error.code).toBe(404);
    expect(resp.error.message).toBe('User not found');
    expect(resp.error.requestId).toBe('req-abc-123');
  });

  // -----------------------------------------------------------------------
  // UserIdentifier (union type)
  // -----------------------------------------------------------------------

  it('UserIdentifier accepts uid, email, or phoneNumber forms', () => {
    const byUid: UserIdentifier = { uid: 'u1' };
    const byEmail: UserIdentifier = { email: 'a@b.com' };
    const byPhone: UserIdentifier = { phoneNumber: '+14155552671' };

    expect(byUid).toHaveProperty('uid');
    expect(byEmail).toHaveProperty('email');
    expect(byPhone).toHaveProperty('phoneNumber');
  });

  // -----------------------------------------------------------------------
  // DeleteUsersResult
  // -----------------------------------------------------------------------

  it('DeleteUsersResult has counts and errors array', () => {
    const result: DeleteUsersResult = {
      successCount: 5,
      failureCount: 2,
      errors: [
        { index: 3, error: { code: 'auth/user-not-found', message: 'Not found' } },
        { index: 6, error: { code: 'auth/internal-error', message: 'Internal' } },
      ],
    };

    expect(result.successCount).toBe(5);
    expect(result.failureCount).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].index).toBe(3);
  });

  // -----------------------------------------------------------------------
  // ListUsersResult
  // -----------------------------------------------------------------------

  it('ListUsersResult has users array and optional pageToken', () => {
    const result: ListUsersResult = {
      users: [],
      pageToken: 'next-page-token',
    };

    expect(result.users).toEqual([]);
    expect(result.pageToken).toBe('next-page-token');

    const lastPage: ListUsersResult = { users: [] };
    expect(lastPage.pageToken).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // ActionCodeSettings
  // -----------------------------------------------------------------------

  it('ActionCodeSettings has url and optional fields', () => {
    const settings: ActionCodeSettings = {
      url: 'https://example.com/action',
      handleCodeInApp: true,
      iOS: { bundleId: 'com.example.app' },
      android: { packageName: 'com.example.android', installApp: true },
      dynamicLinkDomain: 'example.page.link',
    };

    expect(settings.url).toBe('https://example.com/action');
    expect(settings.handleCodeInApp).toBe(true);
    expect(settings.iOS?.bundleId).toBe('com.example.app');
    expect(settings.android?.packageName).toBe('com.example.android');
  });

  // -----------------------------------------------------------------------
  // FirebaseAdapter interface
  // -----------------------------------------------------------------------

  it('FirebaseAdapter interface defines all expected methods', () => {
    // Create a mock object that satisfies the interface
    const adapter: FirebaseAdapter = {
      projectId: 'test',
      isHealthy: () => true,
      verifyIdToken: vi.fn(),
      getUser: vi.fn(),
      getUserByEmail: vi.fn(),
      getUserByPhoneNumber: vi.fn(),
      getUsers: vi.fn(),
      createUser: vi.fn(),
      updateUser: vi.fn(),
      deleteUser: vi.fn(),
      deleteUsers: vi.fn(),
      listUsers: vi.fn(),
      setCustomUserClaims: vi.fn(),
      revokeRefreshTokens: vi.fn(),
      createCustomToken: vi.fn(),
      createSessionCookie: vi.fn(),
      verifySessionCookie: vi.fn(),
      generatePasswordResetLink: vi.fn(),
      generateEmailVerificationLink: vi.fn(),
      generateSignInWithEmailLink: vi.fn(),
    };

    // Verify all expected methods exist
    expect(typeof adapter.isHealthy).toBe('function');
    expect(typeof adapter.verifyIdToken).toBe('function');
    expect(typeof adapter.getUser).toBe('function');
    expect(typeof adapter.getUserByEmail).toBe('function');
    expect(typeof adapter.getUserByPhoneNumber).toBe('function');
    expect(typeof adapter.getUsers).toBe('function');
    expect(typeof adapter.createUser).toBe('function');
    expect(typeof adapter.updateUser).toBe('function');
    expect(typeof adapter.deleteUser).toBe('function');
    expect(typeof adapter.deleteUsers).toBe('function');
    expect(typeof adapter.listUsers).toBe('function');
    expect(typeof adapter.setCustomUserClaims).toBe('function');
    expect(typeof adapter.revokeRefreshTokens).toBe('function');
    expect(typeof adapter.createCustomToken).toBe('function');
    expect(typeof adapter.createSessionCookie).toBe('function');
    expect(typeof adapter.verifySessionCookie).toBe('function');
    expect(typeof adapter.generatePasswordResetLink).toBe('function');
    expect(typeof adapter.generateEmailVerificationLink).toBe('function');
    expect(typeof adapter.generateSignInWithEmailLink).toBe('function');
    expect(typeof adapter.projectId).toBe('string');
  });
});
