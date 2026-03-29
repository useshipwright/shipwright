import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const TEMPLATE_ROOT = join(import.meta.dirname, '..', '..');
const IMAGE_NAME = `smoke-test-${process.pid}`;
const CONTAINER_NAME = `smoke-run-${process.pid}`;
const HOST_PORT = 49152 + Math.floor(Math.random() * 16384);
const BASE_URL = `http://localhost:${HOST_PORT}`;
const STARTUP_WAIT_MS = 8000;
const REQUEST_TIMEOUT_MS = 10_000;

function buildMockServiceAccount(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'smoke-test',
    private_key_id: 'key-id',
    private_key: privateKey,
    client_email: 'smoke@smoke-test.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function exec(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  return execSync(cmd, {
    cwd: opts?.cwd ?? TEMPLATE_ROOT,
    timeout: opts?.timeout ?? 120_000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function tryExec(cmd: string, opts?: { cwd?: string; timeout?: number }): string | null {
  try {
    return exec(cmd, opts);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = REQUEST_TIMEOUT_MS, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...fetchOpts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Build + Run
// ---------------------------------------------------------------------------

function buildImage(): void {
  exec(`docker build -t ${IMAGE_NAME}:latest .`, { timeout: 300_000 });
}

function startContainer(serviceAccountJson: string): void {
  const envFlags = [
    '-e ANTHROPIC_API_KEY=test-key',
    '-e DEEPGRAM_API_KEY=test-key',
    `-e FIREBASE_SERVICE_ACCOUNT=${shellEscape(serviceAccountJson)}`,
    '-e GCS_BUCKET=test-bucket',
    '-e GOOGLE_CLOUD_PROJECT=test-project',
    '-e GOOGLE_CALENDAR_CLIENT_ID=smoke-client-id',
    '-e GOOGLE_CALENDAR_CLIENT_SECRET=smoke-client-secret',
    '-e GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:8080/api/calendar/callback',
    '-e CALENDAR_HMAC_SECRET=smoke-hmac-secret',
    '-e LOG_LEVEL=warn',
  ].join(' ');

  exec(
    `docker run -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:8080 ${envFlags} ${IMAGE_NAME}:latest`,
  );
}

function cleanup(): void {
  tryExec(`docker rm -f ${CONTAINER_NAME}`);
  tryExec(`docker rmi -f ${IMAGE_NAME}:latest`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Smoke tests — built container', { timeout: 360_000 }, () => {
  let mockServiceAccount: string;

  beforeAll(() => {
    mockServiceAccount = buildMockServiceAccount();
  });

  afterAll(() => {
    cleanup();
  });

  // ---- Static checks (no Docker required) ----

  it('Dockerfile CMD references the same entry point as package.json start script', () => {
    const dockerfile = readFileSync(join(TEMPLATE_ROOT, 'Dockerfile'), 'utf-8');
    const pkg = JSON.parse(readFileSync(join(TEMPLATE_ROOT, 'package.json'), 'utf-8'));

    // Extract CMD entry point — supports CMD ["node", "dist/server.js"]
    const cmdMatch = dockerfile.match(/^CMD\s+\[?"?node"?,?\s*"?([^"\]\s]+)"?\]?/m);
    expect(cmdMatch, 'Dockerfile must contain a CMD directive').toBeTruthy();
    const dockerEntryPoint = cmdMatch![1];

    const startScript: string = pkg.scripts?.start ?? '';
    expect(startScript, 'package.json must have a start script').toBeTruthy();
    expect(startScript).toContain(dockerEntryPoint);
  });

  it('Dockerfile HEALTHCHECK path matches registered health route (/health)', () => {
    const dockerfile = readFileSync(join(TEMPLATE_ROOT, 'Dockerfile'), 'utf-8');
    const healthcheckMatch = dockerfile.match(/HEALTHCHECK[\s\S]*?CMD\s+(.+)/m);
    expect(healthcheckMatch, 'Dockerfile must contain a HEALTHCHECK directive').toBeTruthy();
    expect(healthcheckMatch![1]).toContain('/health');
  });

  // ---- Build ----

  it('Docker image builds successfully', () => {
    buildImage();
  });

  // ---- Container lifecycle tests (order-dependent) ----

  it('Container starts and binds to port', async () => {
    startContainer(mockServiceAccount);

    // Wait for the container to accept connections
    await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));

    // Verify container is still running (didn't crash)
    const status = exec(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME}`);
    expect(status).toBe('true');
  });

  it('GET /health returns 200 with version info', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('status', 'ok');
    expect(body.data).toHaveProperty('version');
    expect(typeof body.data.version).toBe('string');
  });

  it('GET /health/ready returns 200 or 503 (endpoint registered and reachable)', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/health/ready`);
    // Mock env vars mean adapters will fail connectivity → 503 is expected
    expect([200, 503]).toContain(res.status);

    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('status');
    expect(body.data).toHaveProperty('checks');
  });

  it('GET /api/meetings without auth returns 401', async () => {
    const res = await fetchWithTimeout(`${BASE_URL}/api/meetings`);
    expect(res.status).toBe(401);
  });

  it('Container runs as non-root (UID != 0)', () => {
    const uid = exec(`docker exec ${CONTAINER_NAME} id -u`);
    expect(Number(uid)).toBeGreaterThan(0);
  });
});
