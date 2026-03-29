/**
 * Health checks plugin tests — T-027.
 *
 * Tests GET /health (liveness) and GET /health/ready (readiness).
 * Uses Fastify directly with mock adapters injected via plugin options.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import healthPlugin from '../../src/plugins/health.js';
import type { FirestoreAdapter, GCSAdapter } from '../../src/types/adapters.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mockFirestoreAdapter(healthy: boolean): Pick<FirestoreAdapter, 'healthCheck'> {
  return {
    healthCheck: vi.fn().mockResolvedValue(healthy),
  };
}

function mockGcsAdapter(healthy: boolean): Pick<GCSAdapter, 'healthCheck'> {
  return {
    healthCheck: vi.fn().mockResolvedValue(healthy),
  };
}

async function buildHealthApp(opts: {
  firestore?: Pick<FirestoreAdapter, 'healthCheck'>;
  gcs?: Pick<GCSAdapter, 'healthCheck'>;
  version?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(healthPlugin, {
    firestore: opts.firestore as FirestoreAdapter | undefined,
    gcs: opts.gcs as GCSAdapter | undefined,
    version: opts.version,
  });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Health Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /health (liveness)', () => {
    it('returns 200 with status ok and version', async () => {
      app = await buildHealthApp({ version: '1.2.3' });
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('ok');
      expect(body.data.version).toBe('1.2.3');
    });

    it('returns default version when not provided', async () => {
      app = await buildHealthApp({});
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.version).toBeDefined();
    });

    it('does not require auth', async () => {
      app = await buildHealthApp({ version: '1.0.0' });
      // No auth headers — should still succeed
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('returns 200 when both Firestore and GCS are healthy', async () => {
      app = await buildHealthApp({
        firestore: mockFirestoreAdapter(true),
        gcs: mockGcsAdapter(true),
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('ok');
      expect(body.data.checks.firestore).toBe(true);
      expect(body.data.checks.gcs).toBe(true);
    });

    it('returns 503 when Firestore is down', async () => {
      app = await buildHealthApp({
        firestore: mockFirestoreAdapter(false),
        gcs: mockGcsAdapter(true),
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('degraded');
      expect(body.data.checks.firestore).toBe(false);
      expect(body.data.checks.gcs).toBe(true);
    });

    it('returns 503 when GCS is down', async () => {
      app = await buildHealthApp({
        firestore: mockFirestoreAdapter(true),
        gcs: mockGcsAdapter(false),
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('degraded');
      expect(body.data.checks.firestore).toBe(true);
      expect(body.data.checks.gcs).toBe(false);
    });

    it('returns 503 when both are down', async () => {
      app = await buildHealthApp({
        firestore: mockFirestoreAdapter(false),
        gcs: mockGcsAdapter(false),
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('degraded');
      expect(body.data.checks.firestore).toBe(false);
      expect(body.data.checks.gcs).toBe(false);
    });

    it('handles Firestore adapter throwing', async () => {
      const firestore = {
        healthCheck: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      app = await buildHealthApp({
        firestore: firestore as unknown as FirestoreAdapter,
        gcs: mockGcsAdapter(true),
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.checks.firestore).toBe(false);
    });

    it('handles GCS adapter throwing', async () => {
      const gcs = {
        healthCheck: vi.fn().mockRejectedValue(new Error('Bucket not found')),
      };
      app = await buildHealthApp({
        firestore: mockFirestoreAdapter(true),
        gcs: gcs as unknown as GCSAdapter,
        version: '1.0.0',
      });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.checks.gcs).toBe(false);
    });

    it('returns 503 when no adapters are provided', async () => {
      app = await buildHealthApp({ version: '1.0.0' });

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('degraded');
    });
  });

  describe('integration: health via standalone Fastify', () => {
    it('GET /health is wired and returns 200', async () => {
      // Integration test using health plugin registered the same way as production
      app = await buildHealthApp({ version: '0.1.0' });
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('ok');
      expect(body.data.version).toBe('0.1.0');
    });
  });
});
