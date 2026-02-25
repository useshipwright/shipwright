/**
 * Log redaction utilities (REQ-007, ADR-007).
 *
 * Partially redacts emails, UIDs, and scrubs patterns that look like
 * service account JSON, bearer tokens, or JWT strings from arbitrary text.
 * Applied as Pino serializers in the logging plugin.
 */

/** Matches a full private key PEM block. */
const PRIVATE_KEY_PEM_PATTERN =
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g;

/** Matches JSON containing service account key fields. */
const SA_JSON_PATTERN =
  /"(?:private_key|private_key_id|client_email|client_id)":\s*"[^"]*"/g;

/** Matches bearer token header values. */
const BEARER_PATTERN = /Bearer\s+([A-Za-z0-9_.\-/+=]+)/gi;

/** Matches a JWT-like string: three dot-separated base64url segments starting with eyJ. */
const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Redact an email to first-char + *** + @domain format.
 * Example: "test@example.com" → "t***@example.com"
 */
export function redactEmail(email: string | null | undefined): string {
  if (email === null || email === undefined || email === '') return '';
  const atIndex = email.indexOf('@');
  if (atIndex < 1) return '***';
  return email[0] + '***' + email.slice(atIndex);
}

/**
 * Redact a UID to first-4-chars + *** format.
 * Example: "abc1def2ghi3" → "abc1***"
 */
export function redactUid(uid: string | null | undefined): string {
  if (uid === null || uid === undefined || uid === '') return '';
  if (uid.length <= 4) return uid[0] + '***';
  return uid.slice(0, 4) + '***';
}

/**
 * Redact a token string: first 10 chars + [REDACTED].
 * Enough to identify token type without exposing the full value.
 */
function redactToken(token: string): string {
  if (token.length <= 10) return '[REDACTED]';
  return token.slice(0, 10) + '[REDACTED]';
}

/**
 * Scrubs sensitive patterns from a string value:
 * - PEM private key blocks → [REDACTED_CREDENTIAL]
 * - SA JSON credential fields → [REDACTED_CREDENTIAL]
 * - Bearer tokens → Bearer + first 10 chars + [REDACTED]
 * - JWT tokens → first 10 chars + [REDACTED]
 */
export function redactString(value: string): string {
  if (!value) return value;

  let result = value;

  // Scrub PEM private keys first (most specific)
  result = result.replace(PRIVATE_KEY_PEM_PATTERN, '[REDACTED_CREDENTIAL]');

  // Scrub SA JSON fields
  result = result.replace(SA_JSON_PATTERN, '[REDACTED_CREDENTIAL]');

  // Scrub bearer tokens — keep "Bearer " prefix + first 10 chars of token
  result = result.replace(
    BEARER_PATTERN,
    (_match, token: string) => 'Bearer ' + redactToken(token),
  );

  // Scrub JWT-like strings (three dot-separated base64url segments starting with eyJ)
  result = result.replace(JWT_PATTERN, (match) => redactToken(match));

  return result;
}

const MAX_REDACT_DEPTH = 8;

/**
 * Deep-scrubs sensitive patterns from an object's string values.
 * Designed for use as a Pino serializer.
 * Returns a new object (does not mutate the input).
 *
 * Protected against circular references (via WeakSet) and deeply nested
 * objects (via depth limit) to prevent stack overflow when processing
 * Node.js request/response objects.
 */
export function redactSensitive(
  obj: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth: number = 0,
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj !== 'object') return obj;

  if (depth >= MAX_REDACT_DEPTH) return '[MaxDepth]';
  if (seen.has(obj as object)) return '[Circular]';
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = redactSensitive(value, seen, depth + 1);
  }
  return result;
}
