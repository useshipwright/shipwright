import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

/**
 * Tests for the firebase plugin (T-009, T-053).
 *
 * The plugin reads credential env vars, calls the appropriate adapter init
 * function, and decorates Fastify with firebaseAuth.
 * We mock the adapter module (not the SDK) per ADR-001.
 *
 * Credential modes (ADR-019):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON → SA JSON key via initFirebase()
 *   2. FIREBASE_USE_ADC=true → ADC via initFirebaseWithADC()
 *   3. Neither → fail-fast
 */

const mockInitFirebase = vi.fn();
const mockInitFirebaseWithADC = vi.fn();
const mockGetFirebaseAuth = vi.fn();

vi.mock('../../src/adapters/firebase-admin.js', () => ({
  initFirebase: mockInitFirebase,
  initFirebaseWithADC: mockInitFirebaseWithADC,
  getFirebaseAuth: mockGetFirebaseAuth,
}));

// Import the plugin after mocks are set up
const { default: firebasePlugin } = await import(
  '../../src/plugins/firebase.js'
);

/** Fake @fastify/sensible plugin that satisfies the dependency name */
const fakeSensible = fp(async () => {}, { name: '@fastify/sensible' });

const VALID_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key: 'fake-key',
  client_email: 'sa@test.iam.gserviceaccount.com',
});

describe('firebase plugin', () => {
  let savedSaJson: string | undefined;
  let savedUseADC: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    savedSaJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    savedUseADC = process.env.FIREBASE_USE_ADC;
  });

  afterEach(() => {
    if (savedSaJson !== undefined) {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = savedSaJson;
    } else {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    }
    if (savedUseADC !== undefined) {
      process.env.FIREBASE_USE_ADC = savedUseADC;
    } else {
      delete process.env.FIREBASE_USE_ADC;
    }
  });

  describe('SA JSON key mode', () => {
    it('reads FIREBASE_SERVICE_ACCOUNT_JSON and calls initFirebase with it', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      delete process.env.FIREBASE_USE_ADC;
      const fakeAuth = { verifyIdToken: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(mockInitFirebase).toHaveBeenCalledWith(VALID_SA_JSON);
      expect(mockInitFirebaseWithADC).not.toHaveBeenCalled();
      expect(mockGetFirebaseAuth).toHaveBeenCalledOnce();
      await app.close();
    });

    it('decorates Fastify instance with firebaseAuth', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      delete process.env.FIREBASE_USE_ADC;
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(app.firebaseAuth).toBe(fakeAuth);
      await app.close();
    });

    it('propagates error when initFirebase throws (fail-fast)', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      delete process.env.FIREBASE_USE_ADC;
      mockInitFirebase.mockImplementation(() => {
        throw new Error('cert() failed: missing project_id');
      });

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);

      await expect(app.ready()).rejects.toThrow(
        'cert() failed: missing project_id',
      );
      await app.close().catch(() => {});
    });

    it('prefers SA JSON key when both FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_USE_ADC are set', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      process.env.FIREBASE_USE_ADC = 'true';
      const fakeAuth = { verifyIdToken: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(mockInitFirebase).toHaveBeenCalledWith(VALID_SA_JSON);
      expect(mockInitFirebaseWithADC).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('ADC mode (Workload Identity Federation — ADR-019)', () => {
    it('calls initFirebaseWithADC when FIREBASE_USE_ADC=true and no SA JSON', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.FIREBASE_USE_ADC = 'true';
      const fakeAuth = { verifyIdToken: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(mockInitFirebaseWithADC).toHaveBeenCalledOnce();
      expect(mockInitFirebase).not.toHaveBeenCalled();
      expect(mockGetFirebaseAuth).toHaveBeenCalledOnce();
      await app.close();
    });

    it('decorates Fastify instance with firebaseAuth in ADC mode', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.FIREBASE_USE_ADC = 'true';
      const fakeAuth = { verifyIdToken: vi.fn(), getUser: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(app.firebaseAuth).toBe(fakeAuth);
      await app.close();
    });

    it('propagates error when initFirebaseWithADC throws', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.FIREBASE_USE_ADC = 'true';
      mockInitFirebaseWithADC.mockImplementation(() => {
        throw new Error('Could not load the default credentials');
      });

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);

      await expect(app.ready()).rejects.toThrow(
        'Could not load the default credentials',
      );
      await app.close().catch(() => {});
    });
  });

  describe('no credential configured', () => {
    it('throws when neither FIREBASE_SERVICE_ACCOUNT_JSON nor FIREBASE_USE_ADC is set', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.FIREBASE_USE_ADC;

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);

      await expect(app.ready()).rejects.toThrow(
        'Firebase credential required',
      );
      await app.close().catch(() => {});
    });

    it('does not treat FIREBASE_USE_ADC=false as ADC mode', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.FIREBASE_USE_ADC = 'false';

      const app = Fastify({ logger: false });
      app.register(fakeSensible);
      app.register(firebasePlugin);

      await expect(app.ready()).rejects.toThrow(
        'Firebase credential required',
      );
      await app.close().catch(() => {});
    });
  });

  describe('logging', () => {
    it('logs success message on SA JSON key init', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SA_JSON;
      delete process.env.FIREBASE_USE_ADC;
      const fakeAuth = { verifyIdToken: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const logMessages: string[] = [];
      const app = Fastify({ logger: false });

      const origInfo = app.log.info.bind(app.log);
      app.log.info = ((...args: unknown[]) => {
        if (typeof args[0] === 'string') logMessages.push(args[0]);
        if (typeof args[1] === 'string') logMessages.push(args[1]);
        return origInfo(...args);
      }) as typeof app.log.info;

      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(
        logMessages.some((m) => m.includes('SA JSON key')),
      ).toBe(true);
      await app.close();
    });

    it('logs success message on ADC init', async () => {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      process.env.FIREBASE_USE_ADC = 'true';
      const fakeAuth = { verifyIdToken: vi.fn() };
      mockGetFirebaseAuth.mockReturnValue(fakeAuth);

      const logMessages: string[] = [];
      const app = Fastify({ logger: false });

      const origInfo = app.log.info.bind(app.log);
      app.log.info = ((...args: unknown[]) => {
        if (typeof args[0] === 'string') logMessages.push(args[0]);
        if (typeof args[1] === 'string') logMessages.push(args[1]);
        return origInfo(...args);
      }) as typeof app.log.info;

      app.register(fakeSensible);
      app.register(firebasePlugin);
      await app.ready();

      expect(
        logMessages.some((m) => m.includes('Application Default Credentials')),
      ).toBe(true);
      await app.close();
    });
  });
});
