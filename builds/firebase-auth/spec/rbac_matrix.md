# RBAC Matrix — PRD — Firebase Auth Verification Service

| Role | Permissions | Access Rules |
|------|------------|--------------|
| Operator (Human) | deploy_cloud_run_service, submit_cloud_builds, create_and_manage_secrets, create_service_accounts, bind_iam_roles, create_artifact_registry_repos, approve_permission_diffs | Interactive approval required before IAM changes are applied. Must authenticate via gcloud with sufficient project-level roles. No programmatic API key — uses OAuth user credentials.
 |
| Service Account (Runtime) | read_secret_values, write_cloud_logs | Least-privilege: only secretmanager.secretAccessor on the specific FIREBASE_SERVICE_ACCOUNT_JSON secret (not project-wide) and logging.logWriter. No run.invoker, no IAM admin, no build permissions. Created per-service deployment, not shared across services.
 |
| Calling Microservice | invoke_cloud_run_service | Must hold roles/run.invoker on this specific Cloud Run service. Authenticates via OIDC identity token from metadata server or workload identity. Traffic must originate from within the same GCP project/VPC (internal ingress). No application-level auth beyond Cloud Run IAM gate.
 |
| Cloud Build Service Account | push_container_images, deploy_cloud_run_revisions, act_as_service_account | roles/artifactregistry.writer to push images, roles/run.developer if deploying from build steps, roles/iam.serviceAccountUser to act as the Cloud Run SA. Should NOT have secretmanager access.
 |
| End User (Blocked) |  | No access. Cloud Run ingress=internal rejects all external traffic with 403 before reaching the application. allow_unauthenticated=false ensures even internal traffic without valid OIDC token is rejected.
 |

## Required External Permissions

### GCP Cloud Run

- **roles/run.admin**: Deploy and configure Cloud Run services (operator)
  - _Risk: Grants full control over all Cloud Run services in the project, not just this service. Consider custom role scoped to specific service name prefix.
_
- **roles/run.invoker**: Allow calling microservices to invoke this Cloud Run service
  - _Risk: Must be granted per-service, not project-wide. If granted project-wide, any service can invoke any other service.
_

### GCP Secret Manager

- **roles/secretmanager.admin**: Create secrets and manage access policies (operator)
  - _Risk: Grants access to ALL secrets in the project. Consider roles/secretmanager.secretCreator + specific IAM bindings instead.
_
- **roles/secretmanager.secretAccessor**: Read FIREBASE_SERVICE_ACCOUNT_JSON at runtime (service SA)
  - _Risk: MUST be bound to the specific secret resource, not project-wide. If project-wide, the service SA can read any secret.
_

### GCP Cloud Build

- **roles/cloudbuild.builds.editor**: Submit and manage container builds (operator)
  - _Risk: Cloud Build steps run with the Cloud Build SA, which may have broad permissions. Build steps could be used for privilege escalation if cloudbuild.yaml is tampered with.
_

### GCP Artifact Registry

- **roles/artifactregistry.admin**: Create Docker repositories (operator)
  - _Risk: Grants write access to all repos in the project. After initial repo creation, can be downgraded to roles/artifactregistry.writer.
_
- **roles/artifactregistry.writer**: Push container images (Cloud Build SA)
  - _Risk: Should be scoped to the specific repository, not project-wide.
_

### GCP IAM

- **roles/iam.serviceAccountAdmin**: Create dedicated service accounts (operator)
  - _Risk: Can create and manage ALL service accounts in the project. Powerful role — operator could create SAs with broader access.
_
- **roles/iam.serviceAccountUser**: Act as the Cloud Run SA during deploy (operator + Cloud Build)
  - _Risk: Allows impersonating the target SA. Must be bound per-SA.
_
- **roles/resourcemanager.projectIamAdmin**: Bind IAM roles to service accounts (operator)
  - _Risk: Can modify ANY IAM binding in the project. This is the most dangerous operator role. Consider using Terraform/IaC with approval workflows instead of granting this to individuals.
_

### Firebase Admin SDK

- **Firebase Authentication Admin (firebaseauth.admin)**: verifyIdToken() (public key only, no SA needed for basic verify), getUser() (requires SA auth), token revocation checks

  - _Risk: Full admin access to Firebase Authentication. Can read all user records, disable accounts, delete users. The service only needs read access — consider roles/firebaseauth.viewer if it supports verifyIdToken(checkRevoked) and getUser().
_

### GCP Cloud Logging

- **roles/logging.logWriter**: Write structured logs from Cloud Run (service SA)
  - _Risk: Low risk. Write-only. Cannot read other services' logs. Default for Cloud Run.
_

### Identity Toolkit API

- **identitytoolkit.googleapis.com (API enablement)**: Required for Firebase Auth operations
  - _Risk: Enabling the API is a one-time operation. The API itself is accessed via the Firebase Admin SDK using the SA credentials.
_
