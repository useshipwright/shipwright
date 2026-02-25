/**
 * JWT structure pre-validation (REQ-009).
 * Validates that a token string has exactly 3 base64url-encoded segments
 * separated by dots. Does NOT verify signature or claims — just structural
 * validation before passing to the Firebase SDK, to fail fast on obviously
 * malformed input.
 *
 * Max length limit prevents memory abuse from extremely long token strings
 * (threat model: JWT Structure Bypass).
 */

const MAX_TOKEN_LENGTH = 8192;
const BASE64URL_SEGMENT = '[A-Za-z0-9_-]+';
// Signature segment uses * (not +) to allow empty signatures from the
// Firebase Auth Emulator, which issues unsigned tokens with alg: "none".
// Production tokens always have signatures; the Firebase SDK validates them.
const BASE64URL_SEGMENT_OPT = '[A-Za-z0-9_-]*';
const JWT_STRUCTURE_REGEX = new RegExp(
  `^${BASE64URL_SEGMENT}\\.${BASE64URL_SEGMENT}\\.${BASE64URL_SEGMENT_OPT}$`,
);

export function isValidJwtStructure(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  if (token.length > MAX_TOKEN_LENGTH) return false;
  return JWT_STRUCTURE_REGEX.test(token);
}
