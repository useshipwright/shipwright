import { describe, it, expect } from 'vitest';
import { isValidJwtStructure } from '../../src/lib/validate-jwt.js';

describe('isValidJwtStructure', () => {
  // --- Valid tokens ---

  it('returns true for a valid 3-segment JWT string', () => {
    const token =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
    expect(isValidJwtStructure(token)).toBe(true);
  });

  it('returns true for a token with base64url characters (- and _)', () => {
    expect(isValidJwtStructure('abc-def_ghi.jkl-mno_pqr.stu-vwx_yz')).toBe(
      true,
    );
  });

  it('returns true for a very long token under 8192 chars', () => {
    const segment = 'a'.repeat(2700);
    const token = `${segment}.${segment}.${segment}`;
    expect(token.length).toBeLessThanOrEqual(8192);
    expect(isValidJwtStructure(token)).toBe(true);
  });

  // --- Invalid tokens ---

  it('returns false for an empty string', () => {
    expect(isValidJwtStructure('')).toBe(false);
  });

  it('returns false for null input', () => {
    expect(isValidJwtStructure(null as unknown as string)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(isValidJwtStructure(undefined as unknown as string)).toBe(false);
  });

  it('returns false for a non-string input (number)', () => {
    expect(isValidJwtStructure(123 as unknown as string)).toBe(false);
  });

  it('returns false for a string with 2 segments (missing signature)', () => {
    expect(isValidJwtStructure('header.payload')).toBe(false);
  });

  it('returns false for a string with 4 segments', () => {
    expect(isValidJwtStructure('a.b.c.d')).toBe(false);
  });

  it('returns false for a string with only dots (..)', () => {
    expect(isValidJwtStructure('..')).toBe(false);
  });

  it('returns false for three dots (...)', () => {
    expect(isValidJwtStructure('...')).toBe(false);
  });

  it('returns false for a token with an empty segment (a..b)', () => {
    expect(isValidJwtStructure('a..b')).toBe(false);
  });

  it('returns false for a token with empty first segment', () => {
    expect(isValidJwtStructure('.payload.signature')).toBe(false);
  });

  it('returns true for a token with empty last segment (emulator unsigned tokens)', () => {
    expect(isValidJwtStructure('header.payload.')).toBe(true);
  });

  it('returns false for segments containing spaces', () => {
    expect(isValidJwtStructure('hea der.payload.signature')).toBe(false);
  });

  it('returns false for segments containing special chars (+)', () => {
    expect(isValidJwtStructure('hea+der.payload.signature')).toBe(false);
  });

  it('returns false for segments containing =  (base64 padding)', () => {
    expect(isValidJwtStructure('header=.payload.signature')).toBe(false);
  });

  it('returns false for segments containing /', () => {
    expect(isValidJwtStructure('hea/der.payload.signature')).toBe(false);
  });

  it('returns false for unicode/multibyte characters in segments', () => {
    expect(isValidJwtStructure('héader.payload.signature')).toBe(false);
  });

  it('returns false for token with leading whitespace', () => {
    expect(isValidJwtStructure(' header.payload.signature')).toBe(false);
  });

  it('returns false for token with trailing whitespace', () => {
    expect(isValidJwtStructure('header.payload.signature ')).toBe(false);
  });

  it('returns false for an extremely long token (>8192 chars)', () => {
    const segment = 'a'.repeat(3000);
    const token = `${segment}.${segment}.${segment}`;
    expect(token.length).toBeGreaterThan(8192);
    expect(isValidJwtStructure(token)).toBe(false);
  });

  it('returns true for a token at exactly 8192 chars', () => {
    // 3 segments + 2 dots = 8192 → each segment = (8192 - 2) / 3 = 2730
    const segment = 'a'.repeat(2730);
    const token = `${segment}.${segment}.${segment}`;
    expect(token.length).toBe(8192);
    expect(isValidJwtStructure(token)).toBe(true);
  });

  it('returns false for a single segment string', () => {
    expect(isValidJwtStructure('justonestring')).toBe(false);
  });
});
