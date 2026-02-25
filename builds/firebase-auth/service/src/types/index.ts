// Re-export Fastify type augmentations (firebaseAuth, correlationId)
import './fastify.js';

// --- Token Metadata ---

export interface TokenMetadata {
  iat: number;
  exp: number;
  auth_time: number;
  iss: string;
  sign_in_provider: string;
}

// --- Verify ---

export interface VerifyRequest {
  token: string;
  /**
   * Opt-in revocation check. When true, verifyIdToken checks the Firebase
   * Auth backend to confirm the token has not been revoked (adds latency).
   * Defaults to false — v1 intentionally defers revocation checking
   * (threat model: Token Replay Attack mitigation).
   */
  check_revoked?: boolean;
}

export interface VerifyResponse {
  uid: string;
  email: string | null;
  email_verified: boolean | null;
  name: string | null;
  picture: string | null;
  custom_claims: Record<string, unknown>;
  token_metadata: TokenMetadata;
}

// --- Batch Verify ---

export interface BatchVerifyRequest {
  tokens: string[];
  /**
   * Opt-in revocation check. When true, verifyIdToken checks the Firebase
   * Auth backend for each token to confirm it has not been revoked.
   * Defaults to false — v1 intentionally defers revocation checking.
   */
  check_revoked?: boolean;
}

export type BatchTokenError = 'expired' | 'invalid' | 'malformed' | 'revoked';

export interface BatchTokenResultValid {
  index: number;
  valid: true;
  uid: string;
  email: string | null;
  email_verified: boolean;
  custom_claims: Record<string, unknown>;
  token_metadata: TokenMetadata;
}

export interface BatchTokenResultInvalid {
  index: number;
  valid: false;
  error: BatchTokenError;
}

export type BatchTokenResult = BatchTokenResultValid | BatchTokenResultInvalid;

export interface BatchSummary {
  total: number;
  valid: number;
  invalid: number;
}

export interface BatchVerifyResponse {
  results: BatchTokenResult[];
  summary: BatchSummary;
}

// --- User Lookup ---

export interface ProviderInfo {
  provider_id: string;
  uid: string;
  email: string | null;
  display_name: string | null;
  photo_url: string | null;
}

export interface UserTimestamps {
  creation_time: string;
  last_sign_in_time: string;
  last_refresh_time: string | null;
}

export interface UserLookupResponse {
  uid: string;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  photo_url: string | null;
  phone_number: string | null;
  disabled: boolean;
  custom_claims: Record<string, unknown> | null;
  provider_data: ProviderInfo[];
  metadata: UserTimestamps;
}

// --- Health ---

export interface HealthResponse {
  status: 'healthy' | 'degraded';
  firebase_initialized: boolean;
  version: string;
  timestamp: string;
}

// --- Error ---

export interface ErrorResponse {
  error: string;
  statusCode: number;
}
