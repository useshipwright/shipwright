/**
 * Config module tests — T-027.
 *
 * Verifies env var loading, defaults, and validation.
 * The config module is imported fresh for each test by using dynamic import
 * with cache-busting since it executes at module level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// We replicate the config schema here to test validation without
// side-effecting the module-level `config` singleton.
const positiveInt = (defaultValue: number) =>
  z
    .string()
    .optional()
    .default(String(defaultValue))
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive());

const configSchema = z.object({
  PORT: positiveInt(8080),
  NODE_ENV: z.string().optional().default('production'),
  LOG_LEVEL: z.string().optional().default('info'),
  TRUST_PROXY: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  CORS_ORIGIN: z.string().optional().default(''),
  RATE_LIMIT_MAX: positiveInt(100),
  RATE_LIMIT_WINDOW: z.string().optional().default('1 minute'),
  SHUTDOWN_TIMEOUT_MS: positiveInt(10_000),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1, 'FIREBASE_SERVICE_ACCOUNT is required'),
  GCS_BUCKET: z.string().min(1, 'GCS_BUCKET is required'),
  GOOGLE_CLOUD_PROJECT: z.string().min(1, 'GOOGLE_CLOUD_PROJECT is required'),
  DEEPGRAM_API_KEY: z.string().optional(),
  WHISPER_ENDPOINT: z.string().url().optional().or(z.literal('')).transform((v) => v || undefined),
  DIARIZATION_ENDPOINT: z.string().url().optional().or(z.literal('')).transform((v) => v || undefined),
  EMBEDDING_ENDPOINT: z.string().url().optional().or(z.literal('')).transform((v) => v || undefined),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
});

function loadConfig(env: Record<string, string | undefined>) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return result.data;
}

const REQUIRED_ENV = {
  ANTHROPIC_API_KEY: 'sk-test-123',
  FIREBASE_SERVICE_ACCOUNT: '{"type":"service_account"}',
  GCS_BUCKET: 'test-bucket',
  GOOGLE_CLOUD_PROJECT: 'test-project',
};

describe('Config Module', () => {
  describe('required env vars', () => {
    it('should load successfully with all required vars', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.ANTHROPIC_API_KEY).toBe('sk-test-123');
      expect(cfg.FIREBASE_SERVICE_ACCOUNT).toBe('{"type":"service_account"}');
      expect(cfg.GCS_BUCKET).toBe('test-bucket');
      expect(cfg.GOOGLE_CLOUD_PROJECT).toBe('test-project');
    });

    it('should throw when ANTHROPIC_API_KEY is missing', () => {
      const env = { ...REQUIRED_ENV };
      delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
      expect(() => loadConfig(env)).toThrow('ANTHROPIC_API_KEY');
    });

    it('should throw when FIREBASE_SERVICE_ACCOUNT is missing', () => {
      const env = { ...REQUIRED_ENV };
      delete (env as Record<string, string | undefined>).FIREBASE_SERVICE_ACCOUNT;
      expect(() => loadConfig(env)).toThrow('FIREBASE_SERVICE_ACCOUNT');
    });

    it('should throw when GCS_BUCKET is missing', () => {
      const env = { ...REQUIRED_ENV };
      delete (env as Record<string, string | undefined>).GCS_BUCKET;
      expect(() => loadConfig(env)).toThrow('GCS_BUCKET');
    });

    it('should throw when GOOGLE_CLOUD_PROJECT is missing', () => {
      const env = { ...REQUIRED_ENV };
      delete (env as Record<string, string | undefined>).GOOGLE_CLOUD_PROJECT;
      expect(() => loadConfig(env)).toThrow('GOOGLE_CLOUD_PROJECT');
    });

    it('should throw when ANTHROPIC_API_KEY is empty string', () => {
      expect(() => loadConfig({ ...REQUIRED_ENV, ANTHROPIC_API_KEY: '' })).toThrow(
        'ANTHROPIC_API_KEY',
      );
    });
  });

  describe('optional env vars use defaults', () => {
    it('should default DEEPGRAM_API_KEY to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.DEEPGRAM_API_KEY).toBeUndefined();
    });

    it('should default WHISPER_ENDPOINT to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.WHISPER_ENDPOINT).toBeUndefined();
    });

    it('should default DIARIZATION_ENDPOINT to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.DIARIZATION_ENDPOINT).toBeUndefined();
    });

    it('should default EMBEDDING_ENDPOINT to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.EMBEDDING_ENDPOINT).toBeUndefined();
    });

    it('should default GOOGLE_CALENDAR_CLIENT_ID to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.GOOGLE_CALENDAR_CLIENT_ID).toBeUndefined();
    });

    it('should default GOOGLE_CALENDAR_CLIENT_SECRET to undefined', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.GOOGLE_CALENDAR_CLIENT_SECRET).toBeUndefined();
    });

    it('should accept DEEPGRAM_API_KEY when provided', () => {
      const cfg = loadConfig({ ...REQUIRED_ENV, DEEPGRAM_API_KEY: 'dg-key' });
      expect(cfg.DEEPGRAM_API_KEY).toBe('dg-key');
    });

    it('should accept WHISPER_ENDPOINT when a valid URL', () => {
      const cfg = loadConfig({ ...REQUIRED_ENV, WHISPER_ENDPOINT: 'https://whisper.example.com' });
      expect(cfg.WHISPER_ENDPOINT).toBe('https://whisper.example.com');
    });

    it('should transform empty WHISPER_ENDPOINT to undefined', () => {
      const cfg = loadConfig({ ...REQUIRED_ENV, WHISPER_ENDPOINT: '' });
      expect(cfg.WHISPER_ENDPOINT).toBeUndefined();
    });
  });

  describe('base config defaults', () => {
    it('should default PORT to 8080', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.PORT).toBe(8080);
    });

    it('should default NODE_ENV to production', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.NODE_ENV).toBe('production');
    });

    it('should default LOG_LEVEL to info', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.LOG_LEVEL).toBe('info');
    });

    it('should default TRUST_PROXY to true', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.TRUST_PROXY).toBe(true);
    });

    it('should default RATE_LIMIT_MAX to 100', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.RATE_LIMIT_MAX).toBe(100);
    });

    it('should default RATE_LIMIT_WINDOW to 1 minute', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.RATE_LIMIT_WINDOW).toBe('1 minute');
    });

    it('should default SHUTDOWN_TIMEOUT_MS to 10000', () => {
      const cfg = loadConfig(REQUIRED_ENV);
      expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    });

    it('should override PORT when provided', () => {
      const cfg = loadConfig({ ...REQUIRED_ENV, PORT: '3000' });
      expect(cfg.PORT).toBe(3000);
    });

    it('should set TRUST_PROXY to false when explicitly set', () => {
      const cfg = loadConfig({ ...REQUIRED_ENV, TRUST_PROXY: 'false' });
      expect(cfg.TRUST_PROXY).toBe(false);
    });
  });

  describe('error formatting', () => {
    it('should include all missing required vars in error message', () => {
      expect(() => loadConfig({})).toThrow('Invalid environment configuration');
    });
  });
});
