import { describe, it, expect } from 'vitest';
import { redactEmail, redactUid, pinoRedactConfig } from '../../src/plugins/log-redactor.js';

// ---------------------------------------------------------------------------
// redactEmail
// ---------------------------------------------------------------------------

describe('redactEmail', () => {
  describe('valid emails', () => {
    it('redacts standard email to u***@example.com pattern', () => {
      expect(redactEmail('user@example.com')).toBe('u***@example.com');
    });

    it('redacts single-char local part', () => {
      expect(redactEmail('a@b.co')).toBe('a***@b.co');
    });

    it('redacts email with subdomain', () => {
      expect(redactEmail('jane@mail.example.org')).toBe('j***@mail.example.org');
    });

    it('preserves full domain for operator correlation', () => {
      const result = redactEmail('admin@corp.internal.example.com');
      expect(result).toBe('a***@corp.internal.example.com');
    });

    it('handles plus-tagged email', () => {
      expect(redactEmail('user+tag@example.com')).toBe('u***@example.com');
    });
  });

  describe('malformed inputs', () => {
    it('returns [no-email] for null', () => {
      expect(redactEmail(null)).toBe('[no-email]');
    });

    it('returns [no-email] for undefined', () => {
      expect(redactEmail(undefined)).toBe('[no-email]');
    });

    it('returns [no-email] for empty string', () => {
      expect(redactEmail('')).toBe('[no-email]');
    });

    it('returns [no-email] for non-string (number)', () => {
      expect(redactEmail(12345)).toBe('[no-email]');
    });

    it('returns [no-email] for non-string (boolean)', () => {
      expect(redactEmail(true)).toBe('[no-email]');
    });

    it('handles string without @ sign', () => {
      const result = redactEmail('noatsign');
      expect(result).toBe('n***');
    });

    it('handles string starting with @', () => {
      const result = redactEmail('@domain.com');
      expect(result).toBe('@***');
    });
  });

  describe('adversarial inputs', () => {
    it('handles very long email', () => {
      const longLocal = 'a'.repeat(1000);
      const email = `${longLocal}@example.com`;
      const result = redactEmail(email);
      expect(result).toBe('a***@example.com');
      // The original local part is fully hidden
      expect(result).not.toContain(longLocal);
    });

    it('handles email with special characters in local part', () => {
      expect(redactEmail('u.s.e.r@example.com')).toBe('u***@example.com');
    });

    it('handles email with unicode characters', () => {
      const result = redactEmail('ü@example.com');
      expect(result).toBe('ü***@example.com');
    });

    it('does not throw on object input', () => {
      expect(redactEmail({})).toBe('[no-email]');
    });

    it('does not throw on array input', () => {
      expect(redactEmail([1, 2, 3])).toBe('[no-email]');
    });
  });
});

// ---------------------------------------------------------------------------
// redactUid
// ---------------------------------------------------------------------------

describe('redactUid', () => {
  describe('valid UIDs', () => {
    it('redacts standard UID to abc...xyz pattern', () => {
      expect(redactUid('abc123def456')).toBe('abc...456');
    });

    it('redacts long UID', () => {
      expect(redactUid('abcdefghij1234567890')).toBe('abc...890');
    });
  });

  describe('short UIDs', () => {
    it('handles UID shorter than 6 chars', () => {
      expect(redactUid('short')).toBe('sho...ort');
    });

    it('handles 2-character UID', () => {
      expect(redactUid('ab')).toBe('ab...ab');
    });

    it('handles 1-character UID', () => {
      expect(redactUid('x')).toBe('x...x');
    });

    it('handles exactly 6 character UID', () => {
      expect(redactUid('abcxyz')).toBe('abc...xyz');
    });
  });

  describe('malformed inputs', () => {
    it('returns [no-uid] for null', () => {
      expect(redactUid(null)).toBe('[no-uid]');
    });

    it('returns [no-uid] for undefined', () => {
      expect(redactUid(undefined)).toBe('[no-uid]');
    });

    it('returns [no-uid] for empty string', () => {
      expect(redactUid('')).toBe('[no-uid]');
    });

    it('returns [no-uid] for non-string (number)', () => {
      expect(redactUid(12345)).toBe('[no-uid]');
    });

    it('returns [no-uid] for non-string (boolean)', () => {
      expect(redactUid(false)).toBe('[no-uid]');
    });
  });

  describe('adversarial inputs', () => {
    it('handles very long UID', () => {
      const longUid = 'a'.repeat(500) + 'zzz';
      const result = redactUid(longUid);
      expect(result).toBe('aaa...zzz');
      // Full UID not exposed
      expect(result.length).toBeLessThan(longUid.length);
    });

    it('handles UID with special characters', () => {
      expect(redactUid('abc<script>xyz')).toBe('abc...xyz');
    });

    it('does not throw on object input', () => {
      expect(redactUid({})).toBe('[no-uid]');
    });

    it('does not throw on array input', () => {
      expect(redactUid([1, 2])).toBe('[no-uid]');
    });
  });
});

// ---------------------------------------------------------------------------
// pinoRedactConfig
// ---------------------------------------------------------------------------

describe('pinoRedactConfig', () => {
  it('has paths array', () => {
    expect(Array.isArray(pinoRedactConfig.paths)).toBe(true);
    expect(pinoRedactConfig.paths.length).toBeGreaterThan(0);
  });

  it('includes x-api-key header redaction', () => {
    expect(pinoRedactConfig.paths).toContain('req.headers["x-api-key"]');
  });

  it('includes password field redaction', () => {
    expect(pinoRedactConfig.paths).toContain('*.password');
  });

  it('includes private_key field redaction', () => {
    expect(pinoRedactConfig.paths).toContain('*.private_key');
  });

  it('uses [REDACTED] as censor value', () => {
    expect(pinoRedactConfig.censor).toBe('[REDACTED]');
  });
});
