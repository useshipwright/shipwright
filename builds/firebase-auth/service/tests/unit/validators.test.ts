import { describe, it, expect } from 'vitest';
import {
  validateEmail,
  validatePhone,
  validateUid,
  validateJwtStructure,
  validateClaimsSize,
  validateReservedClaims,
  validateSessionDuration,
  validateBatchSize,
} from '../../src/domain/validators.js';

// ---------------------------------------------------------------------------
// validateEmail
// ---------------------------------------------------------------------------

describe('validateEmail', () => {
  it('accepts a valid email', () => {
    expect(validateEmail('user@example.com')).toEqual({ valid: true });
  });

  it('accepts email with + tag', () => {
    expect(validateEmail('user+tag@example.com')).toEqual({ valid: true });
  });

  it('accepts email with subdomain', () => {
    expect(validateEmail('user@sub.example.com')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateEmail('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects email without @', () => {
    const result = validateEmail('userexample.com');
    expect(result.valid).toBe(false);
  });

  it('rejects email without domain', () => {
    const result = validateEmail('user@');
    expect(result.valid).toBe(false);
  });

  it('rejects email without TLD', () => {
    const result = validateEmail('user@example');
    expect(result.valid).toBe(false);
  });

  it('rejects email with spaces', () => {
    const result = validateEmail('user @example.com');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePhone
// ---------------------------------------------------------------------------

describe('validatePhone', () => {
  it('accepts valid E.164 phone number', () => {
    expect(validatePhone('+14155552671')).toEqual({ valid: true });
  });

  it('accepts minimum-length E.164 (+ followed by 7 digits)', () => {
    expect(validatePhone('+1234567')).toEqual({ valid: true });
  });

  it('accepts maximum-length E.164 (+ followed by 15 digits)', () => {
    expect(validatePhone('+123456789012345')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validatePhone('');
    expect(result.valid).toBe(false);
  });

  it('rejects phone without + prefix', () => {
    const result = validatePhone('14155552671');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('E.164');
  });

  it('rejects phone with letters', () => {
    const result = validatePhone('+1415abc2671');
    expect(result.valid).toBe(false);
  });

  it('rejects phone that is too short (6 digits after +)', () => {
    const result = validatePhone('+123456');
    expect(result.valid).toBe(false);
  });

  it('rejects phone that is too long (16 digits after +)', () => {
    const result = validatePhone('+1234567890123456');
    expect(result.valid).toBe(false);
  });

  it('rejects phone starting with +0', () => {
    const result = validatePhone('+0234567890');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateUid
// ---------------------------------------------------------------------------

describe('validateUid', () => {
  it('accepts a normal UID', () => {
    expect(validateUid('abc123')).toEqual({ valid: true });
  });

  it('accepts UID at 128-char boundary', () => {
    const uid = 'a'.repeat(128);
    expect(validateUid(uid)).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateUid('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects UID at 129 chars (over boundary)', () => {
    const uid = 'a'.repeat(129);
    const result = validateUid(uid);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('128');
  });

  it('accepts UID with special characters', () => {
    expect(validateUid('user:abc-123_def')).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// validateJwtStructure
// ---------------------------------------------------------------------------

describe('validateJwtStructure', () => {
  const VALID_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ0ZXN0In0.c2lnbmF0dXJl';

  it('accepts valid 3-segment JWT', () => {
    expect(validateJwtStructure(VALID_JWT)).toEqual({ valid: true });
  });

  it('accepts minimal 3-segment base64url', () => {
    expect(validateJwtStructure('aaa.bbb.ccc')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateJwtStructure('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects JWT with 2 segments', () => {
    const result = validateJwtStructure('aaa.bbb');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('3');
  });

  it('rejects JWT with 4 segments', () => {
    const result = validateJwtStructure('aaa.bbb.ccc.ddd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('3');
  });

  it('rejects JWT with empty segment', () => {
    const result = validateJwtStructure('aaa..ccc');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('base64url');
  });

  it('rejects JWT with non-base64url chars (e.g. =)', () => {
    const result = validateJwtStructure('aaa.bb=.ccc');
    expect(result.valid).toBe(false);
  });

  it('rejects plain text (not JWT)', () => {
    const result = validateJwtStructure('not-a-jwt');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaimsSize
// ---------------------------------------------------------------------------

describe('validateClaimsSize', () => {
  it('accepts empty claims object', () => {
    expect(validateClaimsSize({})).toEqual({ valid: true });
  });

  it('accepts claims within 1000 character limit', () => {
    const claims = { role: 'admin' };
    expect(validateClaimsSize(claims)).toEqual({ valid: true });
  });

  it('accepts claims at exactly 1000 characters', () => {
    // JSON.stringify({}) = 2 chars, so we need a payload that serializes to exactly 1000
    // {"x":"..."} where the value pads to 1000
    const overhead = '{"x":""}'; // 8 chars
    const padding = 'a'.repeat(1000 - overhead.length);
    const claims = { x: padding };
    expect(JSON.stringify(claims).length).toBe(1000);
    expect(validateClaimsSize(claims)).toEqual({ valid: true });
  });

  it('rejects claims at 1001 characters', () => {
    const overhead = '{"x":""}'; // 8 chars
    const padding = 'a'.repeat(1001 - overhead.length);
    const claims = { x: padding };
    expect(JSON.stringify(claims).length).toBe(1001);

    const result = validateClaimsSize(claims);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('1000');
  });

  it('counts nested objects toward the limit', () => {
    // Build deeply nested claims that exceed the limit
    const claims = { a: { b: { c: 'x'.repeat(1000) } } };
    const result = validateClaimsSize(claims);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateReservedClaims
// ---------------------------------------------------------------------------

describe('validateReservedClaims', () => {
  it('accepts claims with no reserved names', () => {
    expect(validateReservedClaims({ role: 'admin', org: 'acme' })).toEqual({ valid: true });
  });

  it('accepts empty claims object', () => {
    expect(validateReservedClaims({})).toEqual({ valid: true });
  });

  const RESERVED = [
    'acr', 'amr', 'at_hash', 'aud', 'auth_time', 'azp', 'cnf',
    'c_hash', 'exp', 'firebase', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub',
  ];

  for (const name of RESERVED) {
    it(`rejects reserved claim name: ${name}`, () => {
      const claims = { [name]: 'value' };
      const result = validateReservedClaims(claims);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(name);
    });
  }

  it('lists all reserved names found in error message', () => {
    const claims = { sub: 'x', iss: 'y', role: 'admin' };
    const result = validateReservedClaims(claims);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sub');
    expect(result.error).toContain('iss');
  });
});

// ---------------------------------------------------------------------------
// validateSessionDuration
// ---------------------------------------------------------------------------

describe('validateSessionDuration', () => {
  it('accepts duration at minimum boundary (300000ms = 5 min)', () => {
    expect(validateSessionDuration(300_000)).toEqual({ valid: true });
  });

  it('accepts duration at maximum boundary (1209600000ms = 14 days)', () => {
    expect(validateSessionDuration(1_209_600_000)).toEqual({ valid: true });
  });

  it('accepts duration in the middle range', () => {
    expect(validateSessionDuration(604_800_000)).toEqual({ valid: true }); // 7 days
  });

  it('rejects duration below minimum (299999ms)', () => {
    const result = validateSessionDuration(299_999);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('300000');
  });

  it('rejects duration above maximum (1209600001ms)', () => {
    const result = validateSessionDuration(1_209_600_001);
    expect(result.valid).toBe(false);
  });

  it('rejects NaN', () => {
    const result = validateSessionDuration(NaN);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('finite');
  });

  it('rejects Infinity', () => {
    const result = validateSessionDuration(Infinity);
    expect(result.valid).toBe(false);
  });

  it('rejects negative duration', () => {
    const result = validateSessionDuration(-1);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateBatchSize
// ---------------------------------------------------------------------------

describe('validateBatchSize', () => {
  it('accepts batch with one item', () => {
    expect(validateBatchSize(['a'], 25)).toEqual({ valid: true });
  });

  it('accepts batch at max boundary', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(validateBatchSize(items, 25)).toEqual({ valid: true });
  });

  it('rejects empty batch', () => {
    const result = validateBatchSize([], 25);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one');
  });

  it('rejects batch exceeding max', () => {
    const items = Array.from({ length: 26 }, (_, i) => i);
    const result = validateBatchSize(items, 25);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('26');
    expect(result.error).toContain('25');
  });

  it('works with different max values (100 for user lookup)', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(validateBatchSize(items, 100)).toEqual({ valid: true });

    const tooMany = Array.from({ length: 101 }, (_, i) => i);
    const result = validateBatchSize(tooMany, 100);
    expect(result.valid).toBe(false);
  });

  it('works with max=1000 for batch delete', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    expect(validateBatchSize(items, 1000)).toEqual({ valid: true });

    const tooMany = Array.from({ length: 1001 }, (_, i) => i);
    const result = validateBatchSize(tooMany, 1000);
    expect(result.valid).toBe(false);
  });
});
