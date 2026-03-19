import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'sa@test.iam.gserviceaccount.com',
});

const TEST_API_KEY = 'test-api-key-12345';

// All env var keys the config module reads
const ENV_KEYS = [
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'API_KEYS',
  'PORT',
  'LOG_LEVEL',
  'RATE_LIMIT_READ',
  'RATE_LIMIT_MUTATION',
  'RATE_LIMIT_BATCH',
  'SESSION_COOKIE_MAX_AGE',
  'SHUTDOWN_TIMEOUT',
  'NODE_ENV',
  'CORS_ORIGIN',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set the minimum required env vars for a successful config load. */
function setRequiredEnv() {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
  process.env.API_KEYS = TEST_API_KEY;
  process.env.NODE_ENV = 'test'; // avoid CORS_ORIGIN production warning
}

/** Dynamically import a fresh config module (after vi.resetModules). */
async function loadConfig() {
  const mod = await import('../../src/infra/config.js');
  return mod.config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config (src/infra/config.ts)', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of ENV_KEYS) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (envBackup[k] !== undefined) {
        process.env[k] = envBackup[k];
      } else {
        delete process.env[k];
      }
    }
  });

  // -----------------------------------------------------------------------
  // Successful loading
  // -----------------------------------------------------------------------

  describe('successful loading', () => {
    it('loads with all required env vars and returns frozen config', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();

      expect(cfg.serviceAccountCredential).toEqual(JSON.parse(VALID_SERVICE_ACCOUNT));
      expect(cfg.apiKeys).toBeInstanceOf(Map);
      expect(cfg.apiKeys.size).toBe(1);
      expect(Object.isFrozen(cfg)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fail-fast on missing required vars
  // -----------------------------------------------------------------------

  describe('fail-fast on missing required env vars', () => {
    it('throws when FIREBASE_SERVICE_ACCOUNT_JSON is missing', async () => {
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_JSON');
    });

    it('throws when FIREBASE_SERVICE_ACCOUNT_JSON is empty string', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_JSON');
    });

    it('throws when FIREBASE_SERVICE_ACCOUNT_JSON is whitespace only', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '   ';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_JSON');
    });

    it('throws when API_KEYS is missing', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('API_KEYS');
    });

    it('throws when API_KEYS is empty string', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = '';
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('API_KEYS');
    });
  });

  // -----------------------------------------------------------------------
  // Malformed FIREBASE_SERVICE_ACCOUNT_JSON
  // -----------------------------------------------------------------------

  describe('malformed FIREBASE_SERVICE_ACCOUNT_JSON', () => {
    it('throws on invalid JSON', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{not-json';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('not valid JSON');
    });

    it('throws when JSON is an array', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '[1,2,3]';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('not valid JSON');
    });

    it('throws when JSON is null', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = 'null';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('not valid JSON');
    });

    it('throws when JSON is a string literal', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '"hello"';
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('not valid JSON');
    });
  });

  // -----------------------------------------------------------------------
  // Default values for optional env vars
  // -----------------------------------------------------------------------

  describe('default values for optional env vars', () => {
    it('PORT defaults to 8080', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.port).toBe(8080);
    });

    it('LOG_LEVEL defaults to "info"', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.logLevel).toBe('info');
    });

    it('RATE_LIMIT_READ defaults to 200', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.rateLimitRead).toBe(200);
    });

    it('RATE_LIMIT_MUTATION defaults to 50', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.rateLimitMutation).toBe(50);
    });

    it('RATE_LIMIT_BATCH defaults to 20', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.rateLimitBatch).toBe(20);
    });

    it('SESSION_COOKIE_MAX_AGE defaults to 1209600000', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.sessionCookieMaxAge).toBe(1_209_600_000);
    });

    it('SHUTDOWN_TIMEOUT defaults to 10000', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();
      expect(cfg.shutdownTimeout).toBe(10_000);
    });

    it('NODE_ENV defaults to "production" when unset', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = TEST_API_KEY;
      process.env.CORS_ORIGIN = 'http://localhost'; // suppress warning
      // NODE_ENV intentionally left unset

      const cfg = await loadConfig();
      expect(cfg.nodeEnv).toBe('production');
    });
  });

  // -----------------------------------------------------------------------
  // Optional env var overrides
  // -----------------------------------------------------------------------

  describe('optional env var overrides', () => {
    it('respects PORT override', async () => {
      setRequiredEnv();
      process.env.PORT = '8080';
      const cfg = await loadConfig();
      expect(cfg.port).toBe(8080);
    });

    it('respects LOG_LEVEL override', async () => {
      setRequiredEnv();
      process.env.LOG_LEVEL = 'debug';
      const cfg = await loadConfig();
      expect(cfg.logLevel).toBe('debug');
    });

    it('rejects non-numeric PORT', async () => {
      setRequiredEnv();
      process.env.PORT = 'abc';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT');
    });

    it('rejects negative PORT', async () => {
      setRequiredEnv();
      process.env.PORT = '-1';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT');
    });
  });

  // -----------------------------------------------------------------------
  // API key parsing
  // -----------------------------------------------------------------------

  describe('API key parsing', () => {
    it('parses a single key into Map with sha256 prefix ID', async () => {
      setRequiredEnv();
      const cfg = await loadConfig();

      const expectedId = createHash('sha256').update(TEST_API_KEY).digest('hex').slice(0, 8);
      expect(cfg.apiKeys.has(expectedId)).toBe(true);
      expect(cfg.apiKeys.get(expectedId)).toEqual(Buffer.from(TEST_API_KEY));
    });

    it('parses multiple comma-separated keys', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = 'key-one,key-two,key-three';
      process.env.NODE_ENV = 'test';

      const cfg = await loadConfig();
      expect(cfg.apiKeys.size).toBe(3);
    });

    it('handles trailing comma gracefully', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = 'key-one,key-two,';
      process.env.NODE_ENV = 'test';

      const cfg = await loadConfig();
      expect(cfg.apiKeys.size).toBe(2);
    });

    it('trims whitespace around keys', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = ' key-one , key-two ';
      process.env.NODE_ENV = 'test';

      const cfg = await loadConfig();
      expect(cfg.apiKeys.size).toBe(2);

      const expectedId = createHash('sha256').update('key-one').digest('hex').slice(0, 8);
      expect(cfg.apiKeys.has(expectedId)).toBe(true);
    });

    it('throws when API_KEYS contains only commas and whitespace', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = ', , ,';
      process.env.NODE_ENV = 'test';

      await expect(loadConfig()).rejects.toThrow('no valid keys');
    });
  });

  // -----------------------------------------------------------------------
  // CORS_ORIGIN production warning
  // -----------------------------------------------------------------------

  describe('CORS_ORIGIN', () => {
    it('warns when CORS_ORIGIN is not set in production', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'production';
      // CORS_ORIGIN intentionally left unset

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cfg = await loadConfig();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('CORS_ORIGIN'),
      );
      expect(cfg.corsOrigin).toBeNull();
      warnSpy.mockRestore();
    });

    it('does not warn when CORS_ORIGIN is set', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      process.env.API_KEYS = TEST_API_KEY;
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGIN = 'https://example.com';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cfg = await loadConfig();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(cfg.corsOrigin).toBe('https://example.com');
      warnSpy.mockRestore();
    });
  });
});
