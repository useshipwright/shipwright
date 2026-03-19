import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock functions — available inside vi.mock factories
// ---------------------------------------------------------------------------

const DEFAULT_CREDENTIAL = {
  project_id: 'test-project',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'sa@test.iam.gserviceaccount.com',
};

const mocks = vi.hoisted(() => {
  const mockGetUser = vi.fn();
  const mockVerifyIdToken = vi.fn();
  const mockGetUserByEmail = vi.fn();
  const mockGetUserByPhoneNumber = vi.fn();
  const mockGetUsers = vi.fn();
  const mockCreateUser = vi.fn();
  const mockUpdateUser = vi.fn();
  const mockDeleteUser = vi.fn();
  const mockDeleteUsers = vi.fn();
  const mockListUsers = vi.fn();
  const mockSetCustomUserClaims = vi.fn();
  const mockRevokeRefreshTokens = vi.fn();
  const mockCreateCustomToken = vi.fn();
  const mockCreateSessionCookie = vi.fn();
  const mockVerifySessionCookie = vi.fn();
  const mockGeneratePasswordResetLink = vi.fn();
  const mockGenerateEmailVerificationLink = vi.fn();
  const mockGenerateSignInWithEmailLink = vi.fn();

  const authInstance = {
    getUser: mockGetUser,
    verifyIdToken: mockVerifyIdToken,
    getUserByEmail: mockGetUserByEmail,
    getUserByPhoneNumber: mockGetUserByPhoneNumber,
    getUsers: mockGetUsers,
    createUser: mockCreateUser,
    updateUser: mockUpdateUser,
    deleteUser: mockDeleteUser,
    deleteUsers: mockDeleteUsers,
    listUsers: mockListUsers,
    setCustomUserClaims: mockSetCustomUserClaims,
    revokeRefreshTokens: mockRevokeRefreshTokens,
    createCustomToken: mockCreateCustomToken,
    createSessionCookie: mockCreateSessionCookie,
    verifySessionCookie: mockVerifySessionCookie,
    generatePasswordResetLink: mockGeneratePasswordResetLink,
    generateEmailVerificationLink: mockGenerateEmailVerificationLink,
    generateSignInWithEmailLink: mockGenerateSignInWithEmailLink,
  };

  // Mutable config object — tests can modify serviceAccountCredential
  // before importing the adapter to control initialization behavior.
  const mockConfigObj = {
    serviceAccountCredential: {} as Record<string, unknown>,
  };

  return {
    mockCert: vi.fn().mockReturnValue({ projectId: 'test-project' }),
    mockInitializeApp: vi.fn().mockReturnValue({}),
    mockGetAuth: vi.fn().mockReturnValue(authInstance),
    authInstance,
    mockConfigObj,
    mockGetUser,
    mockVerifyIdToken,
    mockGetUserByEmail,
    mockCreateUser,
    mockDeleteUsers,
    mockListUsers,
    mockCreateCustomToken,
    mockCreateSessionCookie,
    mockVerifySessionCookie,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin/app', () => ({
  cert: mocks.mockCert,
  initializeApp: mocks.mockInitializeApp,
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: mocks.mockGetAuth,
}));

vi.mock('../../src/infra/config.js', () => ({
  config: mocks.mockConfigObj,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_USER_RECORD = {
  uid: 'test-uid-123',
  email: 'test@example.com',
  emailVerified: true,
  displayName: 'Test User',
  phoneNumber: '+14155552671',
  photoURL: 'https://example.com/photo.jpg',
  disabled: false,
  metadata: {
    creationTime: '2024-01-01T00:00:00.000Z',
    lastSignInTime: '2024-01-02T00:00:00.000Z',
    lastRefreshTime: null,
  },
  customClaims: { role: 'admin' },
  providerData: [
    {
      uid: 'google-uid',
      providerId: 'google.com',
      email: 'test@gmail.com',
      displayName: 'Test',
      photoURL: undefined,
      phoneNumber: undefined,
    },
  ],
  tokensValidAfterTime: '2024-01-01T00:00:00.000Z',
};

const MOCK_DECODED_ID_TOKEN = {
  uid: 'test-uid-123',
  email: 'test@example.com',
  email_verified: true,
  iss: 'https://securetoken.google.com/test-project',
  aud: 'test-project',
  iat: 1700000000,
  exp: 1700003600,
  auth_time: 1700000000,
  sub: 'test-uid-123',
  user_id: 'test-uid-123',
  firebase: { sign_in_provider: 'google.com' },
  customRole: 'editor',
};

// ---------------------------------------------------------------------------
// Helper — health probe shortcut
// ---------------------------------------------------------------------------

function setupHealthyProbe() {
  mocks.mockGetUser.mockRejectedValueOnce(
    Object.assign(new Error('User not found'), { code: 'auth/user-not-found' }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('firebase-adapter (src/infra/firebase-adapter.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.mockGetUser.mockReset();
    // Restore default config before each test
    mocks.mockConfigObj.serviceAccountCredential = { ...DEFAULT_CREDENTIAL };
  });

  // -----------------------------------------------------------------------
  // Initialization + health probe (ADR-004)
  // -----------------------------------------------------------------------

  describe('initialization and health probe', () => {
    it('sets healthy=true when probe gets auth/user-not-found (expected)', async () => {
      setupHealthyProbe();

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;

      expect(adapter.isHealthy()).toBe(true);
      expect(mocks.mockCert).toHaveBeenCalledOnce();
      expect(mocks.mockInitializeApp).toHaveBeenCalledOnce();
      expect(mocks.mockGetAuth).toHaveBeenCalledOnce();
    });

    it('sets healthy=true when probe user unexpectedly exists', async () => {
      mocks.mockGetUser.mockResolvedValueOnce(MOCK_USER_RECORD);

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;

      expect(adapter.isHealthy()).toBe(true);
    });

    it('fails fast when probe gets auth/invalid-credential', async () => {
      mocks.mockGetUser.mockRejectedValueOnce(
        Object.assign(new Error('Invalid credential'), { code: 'auth/invalid-credential' }),
      );

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');

      await expect(firebaseAdapterReady).rejects.toThrow('health probe failed');
    });

    it('fails fast when probe gets a network error', async () => {
      mocks.mockGetUser.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');

      await expect(firebaseAdapterReady).rejects.toThrow('health probe failed');
    });
  });

  // -----------------------------------------------------------------------
  // projectId
  // -----------------------------------------------------------------------

  describe('projectId', () => {
    it('exposes projectId from service account credential', async () => {
      setupHealthyProbe();

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;

      expect(adapter.projectId).toBe('test-project');
    });
  });

  // -----------------------------------------------------------------------
  // Missing project_id
  // -----------------------------------------------------------------------

  describe('missing project_id', () => {
    it('throws when service account has no project_id', async () => {
      // Remove project_id from the mutable config
      delete mocks.mockConfigObj.serviceAccountCredential.project_id;

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');

      await expect(firebaseAdapterReady).rejects.toThrow('project_id');
    });
  });

  // -----------------------------------------------------------------------
  // isHealthy()
  // -----------------------------------------------------------------------

  describe('isHealthy()', () => {
    it('returns true after successful init', async () => {
      setupHealthyProbe();

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;

      expect(adapter.isHealthy()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — verifyIdToken
  // -----------------------------------------------------------------------

  describe('verifyIdToken delegation', () => {
    it('delegates to auth.verifyIdToken and maps result to DecodedToken', async () => {
      setupHealthyProbe();
      mocks.mockVerifyIdToken.mockResolvedValueOnce(MOCK_DECODED_ID_TOKEN);

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;
      const result = await adapter.verifyIdToken('fake-token', false);

      expect(mocks.mockVerifyIdToken).toHaveBeenCalledWith('fake-token', false);
      expect(result.uid).toBe('test-uid-123');
      expect(result.email).toBe('test@example.com');
      expect(result.emailVerified).toBe(true);
      expect(result.iss).toBe('https://securetoken.google.com/test-project');
      expect(result.aud).toBe('test-project');
      expect(result.iat).toBe(1700000000);
      expect(result.exp).toBe(1700003600);
      expect(result.auth_time).toBe(1700000000);
      // Custom claims extracted (non-standard fields)
      expect(result.claims).toHaveProperty('customRole', 'editor');
      // Standard fields NOT in custom claims
      expect(result.claims).not.toHaveProperty('sub');
      expect(result.claims).not.toHaveProperty('firebase');
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — getUser
  // -----------------------------------------------------------------------

  describe('getUser delegation', () => {
    it('delegates to auth.getUser and maps result to UserProfile', async () => {
      setupHealthyProbe();

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;

      // Set up the actual getUser call (after health probe consumed the first mock)
      mocks.mockGetUser.mockResolvedValueOnce(MOCK_USER_RECORD);
      const result = await adapter.getUser('test-uid-123');

      expect(result.uid).toBe('test-uid-123');
      expect(result.email).toBe('test@example.com');
      expect(result.emailVerified).toBe(true);
      expect(result.displayName).toBe('Test User');
      expect(result.phoneNumber).toBe('+14155552671');
      expect(result.disabled).toBe(false);
      expect(result.metadata.creationTime).toBe('2024-01-01T00:00:00.000Z');
      expect(result.customClaims).toEqual({ role: 'admin' });
      expect(result.providerData).toHaveLength(1);
      expect(result.providerData[0].providerId).toBe('google.com');
      expect(result.tokensValidAfterTime).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — createCustomToken
  // -----------------------------------------------------------------------

  describe('createCustomToken delegation', () => {
    it('delegates to auth.createCustomToken', async () => {
      setupHealthyProbe();
      mocks.mockCreateCustomToken.mockResolvedValueOnce('custom-token-abc');

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;
      const token = await adapter.createCustomToken('uid-1', { role: 'admin' });

      expect(mocks.mockCreateCustomToken).toHaveBeenCalledWith('uid-1', { role: 'admin' });
      expect(token).toBe('custom-token-abc');
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — deleteUsers (batch)
  // -----------------------------------------------------------------------

  describe('deleteUsers delegation', () => {
    it('delegates to auth.deleteUsers and maps result', async () => {
      setupHealthyProbe();
      mocks.mockDeleteUsers.mockResolvedValueOnce({
        successCount: 2,
        failureCount: 1,
        errors: [
          {
            index: 2,
            error: { code: 'auth/user-not-found', message: 'User not found' },
          },
        ],
      });

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;
      const result = await adapter.deleteUsers(['uid-1', 'uid-2', 'uid-3']);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(2);
      expect(result.errors[0].error.code).toBe('auth/user-not-found');
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — listUsers
  // -----------------------------------------------------------------------

  describe('listUsers delegation', () => {
    it('delegates to auth.listUsers and maps result', async () => {
      setupHealthyProbe();
      mocks.mockListUsers.mockResolvedValueOnce({
        users: [MOCK_USER_RECORD],
        pageToken: 'next-page',
      });

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;
      const result = await adapter.listUsers(10, undefined);

      expect(mocks.mockListUsers).toHaveBeenCalledWith(10, undefined);
      expect(result.users).toHaveLength(1);
      expect(result.users[0].uid).toBe('test-uid-123');
      expect(result.pageToken).toBe('next-page');
    });
  });

  // -----------------------------------------------------------------------
  // Method delegation — createSessionCookie
  // -----------------------------------------------------------------------

  describe('createSessionCookie delegation', () => {
    it('delegates to auth.createSessionCookie with correct options', async () => {
      setupHealthyProbe();
      mocks.mockCreateSessionCookie.mockResolvedValueOnce('session-cookie-value');

      const { firebaseAdapterReady } = await import('../../src/infra/firebase-adapter.js');
      const adapter = await firebaseAdapterReady;
      const cookie = await adapter.createSessionCookie('id-token', 604_800_000);

      expect(mocks.mockCreateSessionCookie).toHaveBeenCalledWith('id-token', {
        expiresIn: 604_800_000,
      });
      expect(cookie).toBe('session-cookie-value');
    });
  });
});
