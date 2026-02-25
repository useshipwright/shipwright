import { describe, it, expect } from 'vitest';
import {
  redactEmail,
  redactUid,
  redactString,
  redactSensitive,
} from '../../src/lib/redact.js';

// ---------------------------------------------------------------------------
// redactEmail
// ---------------------------------------------------------------------------
describe('redactEmail', () => {
  it('redacts a standard email: test@example.com → t***@example.com', () => {
    expect(redactEmail('test@example.com')).toBe('t***@example.com');
  });

  it('redacts a single-character local part: a@b.com → a***@b.com', () => {
    expect(redactEmail('a@b.com')).toBe('a***@b.com');
  });

  it('redacts email with plus addressing: test+tag@example.com → t***@example.com', () => {
    expect(redactEmail('test+tag@example.com')).toBe('t***@example.com');
  });

  it('redacts email with dots in local part: first.last@example.com → f***@example.com', () => {
    expect(redactEmail('first.last@example.com')).toBe('f***@example.com');
  });

  it('redacts email with subdomain: user@mail.example.co.uk → u***@mail.example.co.uk', () => {
    expect(redactEmail('user@mail.example.co.uk')).toBe(
      'u***@mail.example.co.uk',
    );
  });

  it('returns empty string for empty input', () => {
    expect(redactEmail('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(redactEmail(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(redactEmail(undefined)).toBe('');
  });

  it('returns *** for a string without @ symbol', () => {
    expect(redactEmail('notanemail')).toBe('***');
  });

  it('returns *** when @ is the first character', () => {
    expect(redactEmail('@example.com')).toBe('***');
  });

  it('handles multiple @ symbols (uses first @)', () => {
    const result = redactEmail('user@bad@example.com');
    expect(result).toBe('u***@bad@example.com');
  });

  it('handles a very long email (>254 chars)', () => {
    const local = 'a'.repeat(200);
    const email = `${local}@example.com`;
    expect(redactEmail(email)).toBe('a***@example.com');
  });
});

// ---------------------------------------------------------------------------
// redactUid
// ---------------------------------------------------------------------------
describe('redactUid', () => {
  it('redacts a standard UID: abcdef123456 → abcd***', () => {
    expect(redactUid('abcdef123456')).toBe('abcd***');
  });

  it('redacts a UID exactly 4 chars: abcd → a***', () => {
    expect(redactUid('abcd')).toBe('a***');
  });

  it('redacts a UID shorter than 4 chars: ab → a***', () => {
    expect(redactUid('ab')).toBe('a***');
  });

  it('redacts a single char UID: x → x***', () => {
    expect(redactUid('x')).toBe('x***');
  });

  it('returns empty string for empty input', () => {
    expect(redactUid('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(redactUid(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(redactUid(undefined)).toBe('');
  });

  it('handles a UID at max length (128 chars)', () => {
    const uid = 'a'.repeat(128);
    expect(redactUid(uid)).toBe('aaaa***');
  });

  it('handles a UID with special characters (hyphens, underscores)', () => {
    expect(redactUid('ab-c_def')).toBe('ab-c***');
  });

  it('redacts a UID exactly 5 chars: abcde → abcd***', () => {
    expect(redactUid('abcde')).toBe('abcd***');
  });
});

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------
describe('redactString', () => {
  it('redacts a JWT-shaped string (eyJ... three segments)', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
    const result = redactString(jwt);
    expect(result).toBe('eyJhbGciOi[REDACTED]');
  });

  it('redacts a bearer token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2ln';
    const result = redactString(input);
    expect(result).toContain('Bearer ');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('c2ln');
  });

  it('redacts a PEM private key block', () => {
    const input =
      'key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----';
    const result = redactString(input);
    expect(result).toContain('[REDACTED_CREDENTIAL]');
    expect(result).not.toContain('MIIEvQIBADANBg');
  });

  it('redacts an RSA private key block', () => {
    const input =
      '-----BEGIN RSA PRIVATE KEY-----\nsecretdata\n-----END RSA PRIVATE KEY-----';
    const result = redactString(input);
    expect(result).toBe('[REDACTED_CREDENTIAL]');
  });

  it('redacts service account JSON fields (private_key)', () => {
    const input = '{"private_key": "-----BEGIN RSA..."}';
    const result = redactString(input);
    expect(result).toContain('[REDACTED_CREDENTIAL]');
    expect(result).not.toContain('BEGIN RSA');
  });

  it('redacts service account JSON fields (client_email)', () => {
    const input = '{"client_email": "sa@project.iam.gserviceaccount.com"}';
    const result = redactString(input);
    expect(result).toContain('[REDACTED_CREDENTIAL]');
    expect(result).not.toContain('gserviceaccount');
  });

  it('passes through a string with no sensitive values', () => {
    const input = 'Hello, this is a normal log message.';
    expect(redactString(input)).toBe(input);
  });

  it('returns empty string for empty input', () => {
    expect(redactString('')).toBe('');
  });

  it('handles bearer token with short token value', () => {
    const result = redactString('Bearer tiny');
    expect(result).toBe('Bearer [REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// redactSensitive
// ---------------------------------------------------------------------------
describe('redactSensitive', () => {
  it('returns null for null input', () => {
    expect(redactSensitive(null)).toBeNull();
  });

  it('returns undefined for undefined input', () => {
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it('passes through numbers unchanged', () => {
    expect(redactSensitive(42)).toBe(42);
  });

  it('passes through booleans unchanged', () => {
    expect(redactSensitive(true)).toBe(true);
  });

  it('redacts a JWT string value', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
    const result = redactSensitive(jwt);
    expect(result).toBe('eyJhbGciOi[REDACTED]');
  });

  it('redacts a flat object containing a JWT string', () => {
    const obj = {
      token:
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
      name: 'safe',
    };
    const result = redactSensitive(obj) as Record<string, unknown>;
    expect(result.token).toContain('[REDACTED]');
    expect(result.name).toBe('safe');
  });

  it('redacts nested objects with sensitive values at multiple depths', () => {
    const obj = {
      level1: {
        level2: {
          secret: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJz.sig',
        },
      },
      safe: 'hello',
    };
    const result = redactSensitive(obj) as Record<string, unknown>;
    const l1 = result.level1 as Record<string, unknown>;
    const l2 = l1.level2 as Record<string, unknown>;
    expect(l2.secret).toContain('[REDACTED]');
    expect(result.safe).toBe('hello');
  });

  it('redacts array values containing sensitive strings', () => {
    const arr = [
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
      'safe value',
    ];
    const result = redactSensitive(arr) as unknown[];
    expect(result[0]).toContain('[REDACTED]');
    expect(result[1]).toBe('safe value');
  });

  it('passes through an object with no sensitive values unchanged', () => {
    const obj = { a: 'hello', b: 123, c: true };
    expect(redactSensitive(obj)).toEqual(obj);
  });

  it('handles null/undefined values in object properties', () => {
    const obj = { a: null, b: undefined, c: 'safe' };
    const result = redactSensitive(obj) as Record<string, unknown>;
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe('safe');
  });

  it('redacts FIREBASE_SERVICE_ACCOUNT_JSON-like content in any field', () => {
    const obj = {
      config: '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMII...\\n-----END PRIVATE KEY-----\\n", "client_email": "sa@proj.iam.gserviceaccount.com"}',
    };
    const result = redactSensitive(obj) as Record<string, unknown>;
    expect(result.config).toContain('[REDACTED_CREDENTIAL]');
    expect(result.config as string).not.toContain('MII');
  });

  it('does not mutate the original object', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
    const obj = { token: jwt };
    redactSensitive(obj);
    expect(obj.token).toBe(jwt);
  });

  it('handles mixed arrays of objects and strings', () => {
    const arr = [
      { key: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJz.sig' },
      'plain text',
      42,
    ];
    const result = redactSensitive(arr) as unknown[];
    const first = result[0] as Record<string, unknown>;
    expect(first.key).toContain('[REDACTED]');
    expect(result[1]).toBe('plain text');
    expect(result[2]).toBe(42);
  });
});
