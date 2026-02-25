# PRD Validation Report

**Validated:** 2026-02-19
**PRD:** PRD — Firebase Auth Verification Service v1

## Summary

- **Matches:** 17 claims verified against documentation
- **Mismatches:** 3 claims conflict with documentation
- **Unverifiable:** 6 claims could not be verified

## Mismatches

| PRD Section | PRD Claim | Documentation Says | Source |
|-------------|-----------|-------------------|--------|
| 2) Goals | Cache Firebase public keys (JWKS) with auto-refresh | Docs explicitly state: 'Caching is automatic — the SDK handles it internally via UrlKeyFetcher', 'Cache-Control honored — SDK parses max-age (~6 hours)', 'No custom caching needed — REQ-012 is satisfied by SDK defaults for non-serverless deployments.' The PRD listing this as a capability to build is misleading — the SDK already provides it. No custom caching implementation is needed. | firebase — overview.md § Public Key Caching — How It Works (JWKS) |
| 9) IAM Requirements — Operator | Operator needs roles/run.admin, roles/cloudbuild.builds.editor, roles/secretmanager.admin, roles/iam.serviceAccountAdmin, roles/resourcemanager.projectIamAdmin | GCP docs list operator roles as: roles/run.admin, roles/cloudbuild.builds.editor, roles/secretmanager.admin, roles/artifactregistry.admin, roles/iam.serviceAccountUser, and serviceusage.services.use. TWO MISMATCHES: (1) PRD is MISSING roles/artifactregistry.admin — required to create Artifact Registry repositories and push container images. Without this, the build/deploy pipeline will fail. (2) PRD is MISSING roles/iam.serviceAccountUser — required for iam.serviceAccounts.actAs permission when deploying Cloud Run services. PRD lists roles/iam.serviceAccountAdmin (for creating SAs) but this does NOT include the actAs permission needed for deployment. PRD includes roles/resourcemanager.projectIamAdmin which is not in the GCP docs but is reasonable for binding IAM roles at the project level.
 | gcp — overview.md § Permissions & Scopes — Operator |
| 9) IAM Requirements (missing) | PRD does not list Cloud Build service account roles | GCP docs specify Cloud Build SA needs: roles/artifactregistry.writer (push images), roles/run.developer (deploy to Cloud Run), roles/iam.serviceAccountUser (act as Cloud Run SA). These are not mentioned in the PRD's IAM section. | gcp — overview.md § Cloud Build Service Account |

## Matches

| PRD Section | Claim | Status |
|-------------|-------|--------|
| 2) Goals | Verify Firebase-issued ID tokens with full claim extraction | Confirmed |
| 2) Goals | Look up user profiles by UID via Firebase Admin SDK | Confirmed |
| 6) Capabilities | Verify a single Firebase ID token, returning uid, email, custom claims, and token metadata | Confirmed |
| 6) Capabilities | User lookup returns email, display name, provider data, custom claims, disabled status | Confirmed |
| 7) Required Secrets | FIREBASE_SERVICE_ACCOUNT_JSON — Firebase Admin SDK service account JSON credential. Used to initialise the Firebase Admin SDK for token verification and user lookups. | Confirmed |
| 8) Security Principles | Every call must verify the JWT signature, expiry, issuer, and audience. Never trust claims without verification. | Confirmed |
| 8) Security Principles | Token verification errors return generic 401 — do not distinguish between 'expired', 'bad signature', 'wrong audience' in the HTTP response. | Confirmed |
| 8) Security Principles | Validate token format (JWT structure) before passing to Firebase SDK | Confirmed |
| 8) Security Principles | No manual configuration of issuer or audience is required — the project ID is automatically derived from the service account credentials or ADC. | Confirmed |
| 4) Target Environment | Required APIs: Cloud Run, Cloud Build, Secret Manager, IAM, Artifact Registry, Identity Toolkit | Confirmed |
| 8) IAM Requirements | Operator IAM permissions verified via testIamPermissions | Confirmed |
| 4) Target Environment | Secrets provisioned via GCP Secret Manager | Confirmed |
| 4) Target Environment | Build container and deploy to Cloud Run | Confirmed |
| 4) Target Environment | Runtime: TypeScript (Node 20), package manager pnpm, Framework: Fastify | Confirmed |
| 4) Target Environment | Deploy target: GCP Cloud Run | Confirmed |
| 12) Verification | Expired/invalid token is correctly rejected with 401 | Confirmed |
| 13) Observability | Structured JSON logs | Confirmed |
| 13) Observability | Request correlation ID on all endpoints | Confirmed |
| 6) Capabilities — Integration points | All routes are internal (other microservices). Default allow_unauthenticated=false. | Confirmed |
| 9) Verification | User lookup returns profile for valid UID, 404 for unknown | Confirmed |
| 9) Verification | Valid token verified with full claims | Confirmed |
| 8) Security Principles | Secret isolation: FIREBASE_SERVICE_ACCOUNT_JSON must only be used in the Firebase SDK initialisation module | Confirmed |

## Unverifiable

| PRD Section | Claim | Reason |
|-------------|-------|--------|
| 2) Goals | Batch-verify multiple tokens in a single call (max 25) | No batch verification API exists in the Firebase Admin SDK. This would be a custom application-level endpoint that calls verifyIdToken() in a loop. The 25-token limit is an application design choice, not an SDK constraint. |
| 2) Goals | Constant-time operations where security-relevant | Neither Firebase nor GCP domain docs discuss constant-time comparison requirements. The SDK handles all cryptographic verification internally. For the application layer (comparing strings, error codes), constant-time comparison is a general security best practice but not documented in the provided domain sources. |
| 9) IAM Requirements — Service account | Service account needs roles/secretmanager.secretAccessor and roles/logging.logWriter | GCP docs confirm roles/secretmanager.secretAccessor for reading secrets at runtime. roles/logging.logWriter is described as 'Cloud Run default logging' in the PRD but is not explicitly listed in the GCP domain docs for Cloud Run service accounts — Cloud Run has built-in log routing to Cloud Logging without requiring an explicit IAM role on the service account. |
| 12) Verification | Health endpoint responds (as deployment success criterion) | Firebase docs note that initializeApp() succeeds even with invalid credentials — actual validation is lazy. A health endpoint can report 'up' without proving Firebase credentials are valid. The docs suggest calling getUser('nonexistent-uid') and checking for auth/user-not-found (= credentials valid) vs app/invalid-credential (= credentials invalid) for deeper health checks. PRD doesn't specify credential validation in health check. |
| 8) Security Principles (missing consideration) | PRD does not address Firebase Auth Emulator mode | Firebase docs note: 'When FIREBASE_AUTH_EMULATOR_HOST is set, verifyIdToken() skips signature verification and kid header checks entirely.' This is a security concern — if the env var is accidentally set in production, all token verification is bypassed. The PRD should address ensuring this env var is never set in production. |
| 6) Capabilities (missing consideration) | PRD does not mention verifyIdToken() checkRevoked parameter | Firebase docs show verifyIdToken(idToken, checkRevoked?) where checkRevoked=true adds a backend call to check token revocation. The PRD lists 'Token revocation checking' as v1.1 non-goal but doesn't explicitly state whether v1 uses checkRevoked=false. This should be clarified since it affects both behavior and credential requirements (checkRevoked=true requires authenticated API calls). |

