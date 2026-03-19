/**
 * Rate-limit class for route classification.
 * Routes declare which classes apply; the rate limiter plugin
 * consumes from all applicable buckets per request.
 */
export type RateLimitClass = 'read' | 'mutation' | 'batch';

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimitClasses?: RateLimitClass[];
  }
}

// ---------------------------------------------------------------------------
// Route metadata
// ---------------------------------------------------------------------------

export interface RouteMetadata {
  readonly rateLimitClasses: readonly RateLimitClass[];
}

// ---------------------------------------------------------------------------
// User profile & sub-types
// ---------------------------------------------------------------------------

export interface UserMetadata {
  readonly creationTime: string;
  readonly lastSignInTime: string | null;
  readonly lastRefreshTime: string | null;
}

export interface ProviderUserInfo {
  readonly uid: string;
  readonly providerId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
}

export interface UserProfile {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly phoneNumber: string | null;
  readonly photoURL: string | null;
  readonly disabled: boolean;
  readonly metadata: UserMetadata;
  readonly customClaims: Record<string, unknown> | null;
  readonly providerData: readonly ProviderUserInfo[];
  readonly tokensValidAfterTime: string | null;
}

// ---------------------------------------------------------------------------
// Decoded token (from Firebase ID token or session cookie verification)
// ---------------------------------------------------------------------------

export interface DecodedToken {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly claims: Record<string, unknown>;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly auth_time: number;
}

// ---------------------------------------------------------------------------
// Batch verify
// ---------------------------------------------------------------------------

export interface BatchVerifyTokenResult {
  readonly valid: boolean;
  readonly uid?: string;
  readonly email?: string | null;
  readonly claims?: Record<string, unknown>;
  readonly error?: string;
}

export interface BatchVerifySummary {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
}

export interface BatchVerifyResult {
  readonly results: readonly BatchVerifyTokenResult[];
  readonly summary: BatchVerifySummary;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly event: string;
  readonly target: string;
  readonly changes: {
    readonly fields: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Error response envelope
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly requestId: string;
  };
}

// ---------------------------------------------------------------------------
// User identifiers (for batch lookup)
// ---------------------------------------------------------------------------

export type UserIdentifier =
  | { readonly uid: string }
  | { readonly email: string }
  | { readonly phoneNumber: string };

// ---------------------------------------------------------------------------
// Batch delete result
// ---------------------------------------------------------------------------

export interface DeleteUsersResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly errors: readonly {
    readonly index: number;
    readonly error: { readonly code: string; readonly message: string };
  }[];
}

// ---------------------------------------------------------------------------
// List users result
// ---------------------------------------------------------------------------

export interface ListUsersResult {
  readonly users: readonly UserProfile[];
  readonly pageToken?: string;
}

// ---------------------------------------------------------------------------
// Action code settings (for email action links)
// ---------------------------------------------------------------------------

export interface ActionCodeSettings {
  readonly url: string;
  readonly handleCodeInApp?: boolean;
  readonly iOS?: { readonly bundleId: string };
  readonly android?: {
    readonly packageName: string;
    readonly installApp?: boolean;
    readonly minimumVersion?: string;
  };
  readonly dynamicLinkDomain?: string;
}

// ---------------------------------------------------------------------------
// Firebase adapter interface
// ---------------------------------------------------------------------------

export interface FirebaseAdapter {
  readonly projectId: string;
  isHealthy(): boolean;
  shutdown(): Promise<void>;

  // Token verification
  verifyIdToken(token: string, checkRevoked?: boolean): Promise<DecodedToken>;

  // User lookup
  getUser(uid: string): Promise<UserProfile>;
  getUserByEmail(email: string): Promise<UserProfile>;
  getUserByPhoneNumber(phoneNumber: string): Promise<UserProfile>;
  getUsers(identifiers: readonly UserIdentifier[]): Promise<readonly UserProfile[]>;

  // User management
  createUser(properties: Record<string, unknown>): Promise<UserProfile>;
  updateUser(uid: string, properties: Record<string, unknown>): Promise<UserProfile>;
  deleteUser(uid: string): Promise<void>;
  deleteUsers(uids: readonly string[]): Promise<DeleteUsersResult>;

  // User listing
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;

  // Custom claims
  setCustomUserClaims(uid: string, claims: Record<string, unknown> | null): Promise<void>;

  // Token operations
  revokeRefreshTokens(uid: string): Promise<void>;
  createCustomToken(uid: string, claims?: Record<string, unknown>): Promise<string>;

  // Session cookies
  createSessionCookie(idToken: string, expiresIn: number): Promise<string>;
  verifySessionCookie(cookie: string, checkRevoked?: boolean): Promise<DecodedToken>;

  // Email action links
  generatePasswordResetLink(email: string, actionCodeSettings?: ActionCodeSettings): Promise<string>;
  generateEmailVerificationLink(email: string, actionCodeSettings?: ActionCodeSettings): Promise<string>;
  generateSignInWithEmailLink(email: string, actionCodeSettings: ActionCodeSettings): Promise<string>;
}
