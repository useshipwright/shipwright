import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. The service cannot start without it.`,
    );
  }
  return value.trim();
}

function intOrDefault(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (must be a non-negative integer)`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// API key ID derivation — ADR-003
// sha256(key).slice(0, 8) => 8-char hex prefix
// ---------------------------------------------------------------------------

function deriveApiKeyMap(raw: string): ReadonlyMap<string, Buffer> {
  const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('API_KEYS contains no valid keys after parsing.');
  }
  const map = new Map<string, Buffer>();
  for (const key of keys) {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 8);
    map.set(id, Buffer.from(key));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Parse Firebase service account JSON
// ---------------------------------------------------------------------------

function parseServiceAccountJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Parsed value is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Build config
// ---------------------------------------------------------------------------

function loadConfig() {
  const firebaseJson = requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  const apiKeysRaw = requireEnv('API_KEYS');

  const serviceAccountCredential = parseServiceAccountJson(firebaseJson);
  const apiKeys = deriveApiKeyMap(apiKeysRaw);

  const nodeEnv = process.env.NODE_ENV ?? 'production';
  const corsOrigin = process.env.CORS_ORIGIN ?? null;

  if (nodeEnv === 'production' && corsOrigin === null) {
    console.warn('WARNING: CORS_ORIGIN is not set in production. Requests may be rejected by browsers.');
  }

  return Object.freeze({
    serviceAccountCredential,
    apiKeys,
    port: intOrDefault(process.env.PORT, 8080, 'PORT'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    rateLimitRead: intOrDefault(process.env.RATE_LIMIT_READ, 200, 'RATE_LIMIT_READ'),
    rateLimitMutation: intOrDefault(process.env.RATE_LIMIT_MUTATION, 50, 'RATE_LIMIT_MUTATION'),
    rateLimitBatch: intOrDefault(process.env.RATE_LIMIT_BATCH, 20, 'RATE_LIMIT_BATCH'),
    sessionCookieMaxAge: intOrDefault(process.env.SESSION_COOKIE_MAX_AGE, 1_209_600_000, 'SESSION_COOKIE_MAX_AGE'),
    shutdownTimeout: intOrDefault(process.env.SHUTDOWN_TIMEOUT, 10_000, 'SHUTDOWN_TIMEOUT'),
    nodeEnv,
    corsOrigin,
    trustProxy: process.env.TRUST_PROXY !== 'false',
    skipFirebaseHealthProbe: process.env.SKIP_FIREBASE_HEALTH_PROBE === 'true',
    buildSha: process.env.BUILD_SHA ?? null,
  });
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();
