import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SMOKE_PORT = 49152 + Math.floor(Math.random() * 16384);
const CONTAINER_NAME = `smoke-${process.pid}-${Date.now()}`;
const IMAGE_NAME = 'pack-smoke:latest';
const BASE_URL = `http://localhost:${SMOKE_PORT}`;

const API_KEY = 'smoke-test-api-key-00112233445566';
const MOCK_FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'smoke-test',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Container not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Dump container logs for debugging before throwing
  try {
    const logs = execFileSync('docker', ['logs', '--tail', '50', CONTAINER_NAME], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    console.error('Container logs:\n', logs);
  } catch { /* ignore */ }
  throw new Error(`Container did not become healthy within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Smoke test suite
// ---------------------------------------------------------------------------

describe.skipIf(!isDockerAvailable())('Smoke tests — Docker container', () => {
  beforeAll(async () => {
    // Build Docker image
    execFileSync('docker', ['build', '-t', IMAGE_NAME, '.'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 180_000, // 3 min for cold build
    });

    // Start container with required env vars
    execFileSync('docker', [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '-p', `${SMOKE_PORT}:8080`,
      '-e', `API_KEYS=${API_KEY}`,
      '-e', `FIREBASE_SERVICE_ACCOUNT_JSON=${MOCK_FIREBASE_JSON}`,
      '-e', 'SKIP_FIREBASE_HEALTH_PROBE=true',
      '-e', 'LOG_LEVEL=warn',
      IMAGE_NAME,
    ], {
      stdio: 'pipe',
      timeout: 10_000,
    });

    // Wait for the container to become healthy (30s max per acceptance criteria)
    await waitForHealth(BASE_URL, 30_000);
  }, 240_000); // 4 min total (build + start + wait)

  afterAll(() => {
    // Always clean up the container, even on test failure
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' });
    } catch {
      // Container may not exist if beforeAll failed before docker run
    }
  });

  // -------------------------------------------------------------------------
  // Health endpoint
  // -------------------------------------------------------------------------

  it('GET /health returns 200 with expected response shape', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('version');
    expect(typeof body.version).toBe('string');
    expect(body).toHaveProperty('uptime');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThan(0);
    expect(body).toHaveProperty('firebase');
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('unauthenticated request to protected endpoint returns 401', async () => {
    const res = await fetch(`${BASE_URL}/users/test-uid`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 401);
    expect(body.error).toHaveProperty('message', 'Unauthorized');
  });

  // -------------------------------------------------------------------------
  // Metrics endpoint
  // -------------------------------------------------------------------------

  it('GET /metrics returns 200 with Prometheus text format', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\//);

    const text = await res.text();
    // Verify default Node.js / prom-client metrics are present
    expect(text).toContain('http_request_duration_seconds');
  });

  // -------------------------------------------------------------------------
  // Metrics and health are unauthenticated
  // -------------------------------------------------------------------------

  it('GET /health does not require X-API-Key', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    // Should be 200, not 401 — health skips auth
    expect(res.status).toBe(200);
  });

  it('GET /metrics does not require X-API-Key', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    // Should be 200, not 401 — metrics skips auth
    expect(res.status).toBe(200);
  });
});
