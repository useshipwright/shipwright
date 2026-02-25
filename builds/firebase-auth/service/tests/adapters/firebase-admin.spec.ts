import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the firebase-admin adapter (T-007).
 *
 * The adapter IS the thin wrapper around firebase-admin SDK (ADR-001).
 * We mock the SDK packages to test that the adapter calls them correctly.
 * This is the only place where we mock firebase-admin directly.
 */

// Mock firebase-admin/app before any imports that use it
const mockInitializeApp = vi.fn();
const mockCert = vi.fn();
const mockApplicationDefault = vi.fn();
vi.mock('firebase-admin/app', () => ({
  initializeApp: mockInitializeApp,
  cert: mockCert,
  applicationDefault: mockApplicationDefault,
}));

const mockGetAuth = vi.fn();
vi.mock('firebase-admin/auth', () => ({
  getAuth: mockGetAuth,
}));

// Dynamic import the adapter AFTER mocks are set up.
// We need a fresh module for each test to reset the module-level state.
async function importFreshAdapter() {
  // Clear the module cache so we get fresh module-level state (app/auth = null)
  const modulePath = '../../src/adapters/firebase-admin.js';
  // vitest re-evaluates the module on each dynamic import when cache is reset
  vi.resetModules();
  // Re-apply mocks after resetModules
  vi.doMock('firebase-admin/app', () => ({
    initializeApp: mockInitializeApp,
    cert: mockCert,
    applicationDefault: mockApplicationDefault,
  }));
  vi.doMock('firebase-admin/auth', () => ({
    getAuth: mockGetAuth,
  }));
  return import(modulePath);
}

const VALID_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key123',
  private_key:
    '-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'sa@test-project.iam.gserviceaccount.com',
  client_id: '123456789',
});

describe('firebase-admin adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initFirebase', () => {
    it('calls initializeApp with cert() credential from parsed JSON', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeCert = { projectId: 'test-project' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockCert.mockReturnValue(fakeCert);
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebase(VALID_SA_JSON);

      expect(mockCert).toHaveBeenCalledOnce();
      const certArg = mockCert.mock.calls[0][0];
      expect(certArg).toHaveProperty('project_id', 'test-project');
      expect(certArg).toHaveProperty(
        'client_email',
        'sa@test-project.iam.gserviceaccount.com',
      );

      expect(mockInitializeApp).toHaveBeenCalledWith({
        credential: fakeCert,
      });
    });

    it('calls getAuth with the App returned by initializeApp', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockCert.mockReturnValue({});
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebase(VALID_SA_JSON);

      expect(mockGetAuth).toHaveBeenCalledWith(fakeApp);
    });

    it('throws on invalid JSON string', async () => {
      const adapter = await importFreshAdapter();

      expect(() => adapter.initFirebase('not-valid-json')).toThrow(
        /Unexpected token/,
      );
      expect(mockInitializeApp).not.toHaveBeenCalled();
    });

    it('propagates cert() error for JSON missing required fields', async () => {
      mockCert.mockImplementation(() => {
        throw new Error(
          'Certificate object must contain a string "project_id" property',
        );
      });

      const adapter = await importFreshAdapter();

      expect(() => adapter.initFirebase('{}')).toThrow(/project_id/);
      expect(mockInitializeApp).not.toHaveBeenCalled();
    });

    it('throws if called twice (double init)', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockCert.mockReturnValue({});
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebase(VALID_SA_JSON);

      expect(() => adapter.initFirebase(VALID_SA_JSON)).toThrow(
        'Firebase already initialised',
      );
    });
  });

  describe('initFirebaseWithADC', () => {
    it('calls initializeApp with applicationDefault() credential', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeADC = { type: 'adc' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockApplicationDefault.mockReturnValue(fakeADC);
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebaseWithADC();

      expect(mockApplicationDefault).toHaveBeenCalledOnce();
      expect(mockInitializeApp).toHaveBeenCalledWith({
        credential: fakeADC,
      });
      expect(mockCert).not.toHaveBeenCalled();
    });

    it('calls getAuth with the App returned by initializeApp', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockApplicationDefault.mockReturnValue({});
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebaseWithADC();

      expect(mockGetAuth).toHaveBeenCalledWith(fakeApp);
    });

    it('throws if called twice (double init)', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockApplicationDefault.mockReturnValue({});
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebaseWithADC();

      expect(() => adapter.initFirebaseWithADC()).toThrow(
        'Firebase already initialised',
      );
    });

    it('throws if initFirebase was already called', async () => {
      const fakeApp = { name: 'test-app' };
      const fakeAuth = { verifyIdToken: vi.fn() };

      mockCert.mockReturnValue({});
      mockApplicationDefault.mockReturnValue({});
      mockInitializeApp.mockReturnValue(fakeApp);
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebase(VALID_SA_JSON);

      expect(() => adapter.initFirebaseWithADC()).toThrow(
        'Firebase already initialised',
      );
    });
  });

  describe('getFirebaseAuth', () => {
    it('returns Auth instance after initFirebase()', async () => {
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockCert.mockReturnValue({});
      mockInitializeApp.mockReturnValue({ name: 'app' });
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebase(VALID_SA_JSON);

      const auth = adapter.getFirebaseAuth();
      expect(auth).toBe(fakeAuth);
    });

    it('returns Auth instance after initFirebaseWithADC()', async () => {
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockApplicationDefault.mockReturnValue({});
      mockInitializeApp.mockReturnValue({ name: 'app' });
      mockGetAuth.mockReturnValue(fakeAuth);

      const adapter = await importFreshAdapter();
      adapter.initFirebaseWithADC();

      const auth = adapter.getFirebaseAuth();
      expect(auth).toBe(fakeAuth);
    });

    it('throws if called before init', async () => {
      const adapter = await importFreshAdapter();

      expect(() => adapter.getFirebaseAuth()).toThrow(
        'Firebase not initialised',
      );
    });
  });
});
