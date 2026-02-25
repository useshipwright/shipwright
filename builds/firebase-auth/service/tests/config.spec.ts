/**
 * Tests for config.ts — validates PORT and BATCH_RATE_LIMIT_MAX parsing.
 *
 * config.ts runs validation at import time, so each test uses
 * vi.resetModules() + dynamic import to get a fresh config instance.
 * NODE_ENV=test is set to bypass Firebase credential validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    savedEnv.PORT = process.env.PORT;
    savedEnv.NODE_ENV = process.env.NODE_ENV;
    savedEnv.BATCH_RATE_LIMIT_MAX = process.env.BATCH_RATE_LIMIT_MAX;
    savedEnv.BATCH_RATE_LIMIT_WINDOW = process.env.BATCH_RATE_LIMIT_WINDOW;
    savedEnv.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    savedEnv.FIREBASE_USE_ADC = process.env.FIREBASE_USE_ADC;
    savedEnv.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

    // Skip Firebase credential validation in tests
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  async function importConfig() {
    const mod = await import('../src/config.js');
    return mod.config;
  }

  it('defaults PORT to 8080', async () => {
    delete process.env.PORT;
    const config = await importConfig();
    expect(config.port).toBe(8080);
  });

  it('parses valid PORT', async () => {
    process.env.PORT = '3000';
    const config = await importConfig();
    expect(config.port).toBe(3000);
  });

  it('throws on non-numeric PORT', async () => {
    process.env.PORT = 'abc';
    await expect(importConfig()).rejects.toThrow('Invalid PORT: "abc"');
  });

  it('throws on PORT=0', async () => {
    process.env.PORT = '0';
    await expect(importConfig()).rejects.toThrow('Invalid PORT: "0"');
  });

  it('throws on negative PORT', async () => {
    process.env.PORT = '-1';
    await expect(importConfig()).rejects.toThrow('Invalid PORT: "-1"');
  });

  it('defaults BATCH_RATE_LIMIT_MAX to 100', async () => {
    delete process.env.PORT;
    delete process.env.BATCH_RATE_LIMIT_MAX;
    const config = await importConfig();
    expect(config.batchRateLimit.max).toBe(100);
  });

  it('throws on non-numeric BATCH_RATE_LIMIT_MAX', async () => {
    delete process.env.PORT;
    process.env.BATCH_RATE_LIMIT_MAX = 'xyz';
    await expect(importConfig()).rejects.toThrow('Invalid BATCH_RATE_LIMIT_MAX: "xyz"');
  });

  it('throws on negative BATCH_RATE_LIMIT_MAX', async () => {
    delete process.env.PORT;
    process.env.BATCH_RATE_LIMIT_MAX = '-5';
    await expect(importConfig()).rejects.toThrow('Invalid BATCH_RATE_LIMIT_MAX: "-5"');
  });
});
