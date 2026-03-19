/**
 * Pure validation functions with no external dependencies.
 * Each returns { valid, error? } — no HTTP concerns, no side effects.
 */

export interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

const ok: ValidationResult = Object.freeze({ valid: true });

function fail(error: string): ValidationResult {
  return { valid: false, error };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

// Intentionally simple — rejects obvious garbage, not a full RFC 5322 parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): ValidationResult {
  if (!email) return fail('Email is required');
  if (!EMAIL_RE.test(email)) return fail('Invalid email format');
  return ok;
}

// ---------------------------------------------------------------------------
// Phone (E.164)
// ---------------------------------------------------------------------------

// Leading +, followed by 7–15 digits (ITU-T E.164).
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function validatePhone(phone: string): ValidationResult {
  if (!phone) return fail('Phone number is required');
  if (!E164_RE.test(phone))
    return fail('Phone number must be in E.164 format (e.g. +14155552671)');
  return ok;
}

// ---------------------------------------------------------------------------
// UID
// ---------------------------------------------------------------------------

const UID_MAX_LENGTH = 128;

export function validateUid(uid: string): ValidationResult {
  if (!uid) return fail('UID is required');
  if (uid.length > UID_MAX_LENGTH)
    return fail(`UID must be at most ${UID_MAX_LENGTH} characters`);
  return ok;
}

// ---------------------------------------------------------------------------
// JWT structure (lightweight pre-check before Firebase SDK call)
// ---------------------------------------------------------------------------

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function validateJwtStructure(token: string): ValidationResult {
  if (!token) return fail('Token is required');
  const parts = token.split('.');
  if (parts.length !== 3) return fail('Token must have 3 dot-separated segments');
  for (const part of parts) {
    if (!part || !BASE64URL_RE.test(part))
      return fail('Each token segment must be non-empty base64url');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Custom claims size — 1000 characters (JSON.stringify length), per ADR-009/010
// ---------------------------------------------------------------------------

const MAX_CLAIMS_PAYLOAD_SIZE = 1000;

export function validateClaimsSize(claims: Record<string, unknown>): ValidationResult {
  const serialized = JSON.stringify(claims);
  if (serialized.length > MAX_CLAIMS_PAYLOAD_SIZE)
    return fail(
      `Custom claims payload must not exceed ${MAX_CLAIMS_PAYLOAD_SIZE} characters when serialized (got ${serialized.length})`,
    );
  return ok;
}

// ---------------------------------------------------------------------------
// Reserved claim names — Firebase rejects these in custom claims
// ---------------------------------------------------------------------------

const RESERVED_CLAIMS = new Set([
  'acr',
  'amr',
  'at_hash',
  'aud',
  'auth_time',
  'azp',
  'cnf',
  'c_hash',
  'exp',
  'firebase',
  'iat',
  'iss',
  'jti',
  'nbf',
  'nonce',
  'sub',
]);

export function validateReservedClaims(claims: Record<string, unknown>): ValidationResult {
  const reserved = Object.keys(claims).filter((k) => RESERVED_CLAIMS.has(k));
  if (reserved.length > 0)
    return fail(`Claims contain reserved names: ${reserved.join(', ')}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Session duration — 5 minutes (300 000 ms) to 14 days (1 209 600 000 ms)
// ---------------------------------------------------------------------------

const SESSION_MIN_MS = 300_000;
const SESSION_MAX_MS = 1_209_600_000;

export function validateSessionDuration(ms: number): ValidationResult {
  if (!Number.isFinite(ms))
    return fail('Session duration must be a finite number');
  if (ms < SESSION_MIN_MS || ms > SESSION_MAX_MS)
    return fail(
      `Session duration must be between ${SESSION_MIN_MS}ms (5 min) and ${SESSION_MAX_MS}ms (14 days)`,
    );
  return ok;
}

// ---------------------------------------------------------------------------
// Batch size — configurable max
// ---------------------------------------------------------------------------

export function validateBatchSize(
  items: readonly unknown[],
  max: number,
): ValidationResult {
  if (items.length === 0) return fail('Batch must contain at least one item');
  if (items.length > max)
    return fail(`Batch size ${items.length} exceeds maximum of ${max}`);
  return ok;
}
