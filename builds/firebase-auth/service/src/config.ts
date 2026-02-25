function parseIntOrDefault(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: "${value}" (must be a positive integer)`);
  }
  return parsed;
}

export const config = {
  port: parseIntOrDefault(process.env.PORT, 8080, 'PORT'),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  firebaseCredentialJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  firebaseUseADC: process.env.FIREBASE_USE_ADC === 'true',
  batchRateLimit: {
    max: parseIntOrDefault(process.env.BATCH_RATE_LIMIT_MAX, 100, 'BATCH_RATE_LIMIT_MAX'),
    timeWindow: process.env.BATCH_RATE_LIMIT_WINDOW || '1 minute',
  },
} as const;

/**
 * Validate that at least one Firebase credential mode is configured.
 *
 * Per ADR-004 (fail-fast) and ADR-019 (dual credential modes), the app
 * must not start if no credential is available. This check runs at import
 * time so the process exits before Fastify even begins plugin registration.
 *
 * Credential modes (checked in order):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON — SA JSON key (v1 default)
 *   2. FIREBASE_USE_ADC=true — Application Default Credentials (WIF)
 *   3. GOOGLE_APPLICATION_CREDENTIALS — standard GCP ADC file path
 *   4. None → throw (container won't start)
 *
 * Skipped in test environments (NODE_ENV=test) where Firebase is mocked.
 */
if (process.env.NODE_ENV !== 'test' && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  const hasExplicitCreds = !!config.firebaseCredentialJson;
  const hasADC =
    config.firebaseUseADC || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!hasExplicitCreds && !hasADC) {
    throw new Error(
      'Firebase credential required at startup: set FIREBASE_SERVICE_ACCOUNT_JSON, ' +
        'FIREBASE_USE_ADC=true, or GOOGLE_APPLICATION_CREDENTIALS',
    );
  }
}
