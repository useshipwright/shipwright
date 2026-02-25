import { describe, it, expect } from 'vitest';
import { redactingErrSerializer } from '../src/plugins/logging.js';

/**
 * Tests for T-037: err serializer coverage in logging plugin.
 *
 * Verifies that the Pino err serializer is chained with redaction to
 * prevent credential leakage in uncaught exception stack traces.
 *
 * Threat model: "Credential Exposure in Logs"
 */

const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
  client_id: '123456789',
});

const FAKE_JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIn0.dGVzdHNpZ25hdHVyZXZhbHVl';

const FAKE_BEARER = 'Bearer ya29.a0AfH6SMBx123456789abcdef';

describe('redactingErrSerializer', () => {
  it('is a function compatible with Pino serializers', () => {
    expect(typeof redactingErrSerializer).toBe('function');
  });

  it('serializes a basic Error without credentials unchanged (except structure)', () => {
    const err = new Error('Something went wrong');
    const serialized = redactingErrSerializer(err);

    expect(serialized.type).toBe('Error');
    expect(serialized.message).toBe('Something went wrong');
    expect(serialized.stack).toContain('Something went wrong');
  });

  it('redacts JWT tokens from error message', () => {
    const err = new Error(`Token verification failed: ${FAKE_JWT}`);
    const serialized = redactingErrSerializer(err);

    expect(serialized.message).not.toContain(FAKE_JWT);
    expect(serialized.message).toContain('[REDACTED]');
    expect(serialized.message).toContain('Token verification failed');
  });

  it('redacts bearer tokens from error message', () => {
    const err = new Error(`Auth header contained: ${FAKE_BEARER}`);
    const serialized = redactingErrSerializer(err);

    // Full bearer token value is redacted — only first 10 chars kept
    expect(serialized.message).not.toContain('ya29.a0AfH6SMBx123456789abcdef');
    expect(serialized.message).toContain('Bearer ya29.a0AfH[REDACTED]');
  });

  it('redacts service account JSON credential fields from error message', () => {
    const err = new Error(
      `Failed to parse credential: "private_key": "-----BEGIN RSA PRIVATE KEY-----"`,
    );
    const serialized = redactingErrSerializer(err);

    expect(serialized.message).not.toContain('private_key');
    expect(serialized.message).toContain('[REDACTED_CREDENTIAL]');
  });

  it('redacts PEM private key blocks from error message', () => {
    const err = new Error(
      `Init failed with key: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`,
    );
    const serialized = redactingErrSerializer(err);

    expect(serialized.message).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(serialized.message).toContain('[REDACTED_CREDENTIAL]');
  });

  it('redacts credentials from error stack traces', () => {
    const err = new Error('init failed');
    // Simulate a stack trace that contains credential data
    err.stack = `Error: init failed\n    at initFirebase (firebase-admin.ts:15)\n    credential: ${FAKE_SA_JSON}`;
    const serialized = redactingErrSerializer(err);

    expect(serialized.stack).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(serialized.stack).not.toContain('firebase-adminsdk@test-project');
    expect(serialized.stack).toContain('[REDACTED_CREDENTIAL]');
  });

  it('redacts JWT tokens from error stack traces', () => {
    const err = new Error('verification failed');
    err.stack = `Error: verification failed\n    token: ${FAKE_JWT}\n    at verify (verify.ts:42)`;
    const serialized = redactingErrSerializer(err);

    expect(serialized.stack).not.toContain(FAKE_JWT);
    expect(serialized.stack).toContain('[REDACTED]');
  });

  it('handles errors with multiple credential types in message', () => {
    const err = new Error(
      `Debug: bearer=${FAKE_BEARER}, jwt=${FAKE_JWT}, "private_key": "secret123"`,
    );
    const serialized = redactingErrSerializer(err);

    // Full bearer token is redacted — first 10 chars kept per redactToken()
    expect(serialized.message).not.toContain('ya29.a0AfH6SMBx123456789abcdef');
    expect(serialized.message).not.toContain(FAKE_JWT);
    expect(serialized.message).not.toContain('"private_key"');
    expect(serialized.message).toContain('Bearer ya29.a0AfH[REDACTED]');
    expect(serialized.message).toContain('[REDACTED_CREDENTIAL]');
  });

  it('preserves standard serialized error properties', () => {
    const err = new Error('test error');
    const serialized = redactingErrSerializer(err);

    expect(serialized).toHaveProperty('type');
    expect(serialized).toHaveProperty('message');
    expect(serialized).toHaveProperty('stack');
    expect(serialized.type).toBe('Error');
  });

  it('handles errors with no message gracefully', () => {
    const err = new Error();
    const serialized = redactingErrSerializer(err);

    expect(serialized.type).toBe('Error');
    expect(serialized.message).toBe('');
  });

  it('handles custom error types', () => {
    class FirebaseAuthError extends Error {
      constructor(
        message: string,
        public code: string,
      ) {
        super(message);
        this.name = 'FirebaseAuthError';
      }
    }

    const err = new FirebaseAuthError(
      `auth/invalid-credential: ${FAKE_JWT}`,
      'auth/invalid-credential',
    );
    const serialized = redactingErrSerializer(err);

    expect(serialized.type).toBe('FirebaseAuthError');
    expect(serialized.message).not.toContain(FAKE_JWT);
    expect(serialized.message).toContain('auth/invalid-credential');
    expect(serialized.message).toContain('[REDACTED]');
  });

  it('does not double-redact already-redacted strings', () => {
    const err = new Error('Token was [REDACTED] and Bearer [REDACTED]');
    const serialized = redactingErrSerializer(err);

    expect(serialized.message).toBe(
      'Token was [REDACTED] and Bearer [REDACTED]',
    );
  });
});
