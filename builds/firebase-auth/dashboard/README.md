# Firebase Auth Admin Dashboard

A full-featured admin panel for the Firebase Auth Verification Service, built with Next.js 15 and pure Tailwind CSS. Covers all 22 service endpoints across 5 tabs -- user management, custom claims, token operations, session cookies, and email action links.

**Zero additional dependencies** beyond React, Next.js, Firebase SDK, and Tailwind.

Built entirely by [Shipwright](https://shipwright.build) -- 55 tasks, 0 failures, Grade A.

## Screenshots

<!-- Add screenshots here -->
<!-- ![Overview](./screenshots/overview.png) -->
<!-- ![Users](./screenshots/users.png) -->
<!-- ![Claims](./screenshots/claims.png) -->
<!-- ![Tokens](./screenshots/tokens.png) -->
<!-- ![Email](./screenshots/email.png) -->

## Features

### Overview Tab
- Live service health indicator with version, uptime, and Firebase connection status
- Your account card showing UID, email, display name, verification status
- Token verification (verify your current ID token, inspect decoded claims)
- User record lookup via the Firebase Admin SDK
- Quick action links to all other tabs

### Users Tab
- **Paginated user table** with forward/back navigation (10 per page)
- **Search** by UID, email, or phone number
- **Create user** with email, password, and display name
- **Disable/Enable** accounts with a single click
- **Delete** with inline confirmation (no modal)
- **Expandable rows** showing full user details: metadata, providers, custom claims

### Claims Tab
- Load any user by UID (pre-filled with your own)
- View current custom claims in a formatted JSON panel
- **Preset buttons**: Admin, Beta Tier, Viewer
- **JSON editor** for arbitrary claims
- **Set Claims** (PUT) and **Clear All** (DELETE)
- Auto-refresh after every mutation

### Tokens Tab
- **Verify ID Token**: paste or auto-fill your current token, optional revocation check
- **Session Cookies**: create from your current token (configurable expiry), verify any cookie
- **Custom Tokens**: mint tokens for any UID with optional claims
- **Revoke Refresh Tokens**: invalidate all sessions for a user

### Email Tab
- **Password Reset**: generate a reset link for any email
- **Email Verification**: generate a verification link
- **Sign-In Link**: generate a passwordless sign-in link
- All fields pre-filled with your current email

## API Coverage

All 22 service endpoints are accessible through a single proxy route with a path allowlist:

| Endpoint | Method | Dashboard Location |
|----------|--------|--------------------|
| `/health` | GET | Overview (auto-poll) |
| `/verify` | POST | Overview, Tokens |
| `/batch-verify` | POST | Batch (legacy tab) |
| `/users` | GET | Users (paginated list) |
| `/users` | POST | Users (create) |
| `/users/:uid` | GET | Users (search), Claims (load) |
| `/users/:uid` | PATCH | -- |
| `/users/:uid` | DELETE | Users (delete) |
| `/users/:uid/disable` | POST | Users (toggle) |
| `/users/:uid/enable` | POST | Users (toggle) |
| `/users/:uid/claims` | PUT | Claims (set) |
| `/users/:uid/claims` | DELETE | Claims (clear all) |
| `/users/:uid/revoke` | POST | Tokens (revoke) |
| `/users/by-email/:email` | GET | Users (search) |
| `/users/by-phone/:phone` | GET | Users (search) |
| `/users/batch` | POST | -- |
| `/users/batch-delete` | POST | -- |
| `/sessions` | POST | Tokens (create session) |
| `/sessions/verify` | POST | Tokens (verify session) |
| `/tokens/custom` | POST | Tokens (mint) |
| `/email-actions/password-reset` | POST | Email |
| `/email-actions/verification` | POST | Email |
| `/email-actions/sign-in` | POST | Email |

## Quick Start

### Option 1: Test script (recommended)

```bash
bash test-dashboard.sh
```

This script:
1. Creates `.env` for the service with your Firebase service account
2. Creates `.env.local` for the dashboard with matching API key
3. Starts the service via Docker Compose
4. Waits for health check
5. Starts the dashboard on http://localhost:3000
6. Ctrl+C tears down both

### Option 2: Manual setup

```bash
# 1. Start the service
cd ../template
cp .env.example .env  # configure FIREBASE_SERVICE_ACCOUNT_JSON and API_KEYS
docker compose up -d --build

# 2. Start the dashboard
cd ../dashboard
cp .env.local.example .env.local  # configure all variables
npm install
npm run dev
```

Open http://localhost:3000 and sign in with Google.

## Configuration

### Dashboard (`.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes | Firebase Web API key (from Firebase Console) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | `<project>.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes | GCP project ID |
| `FIREBASE_AUTH_SERVICE_URL` | Yes | URL of the Fastify service (default: `http://localhost:8080`) |
| `FIREBASE_AUTH_SERVICE_API_KEY` | Yes | Must match `API_KEYS` in the service config |
| `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` | No | Connect to Firebase Auth Emulator |

### Service (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEYS` | Yes | Comma-separated API keys for `X-API-Key` auth |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | Service account JSON (single line) |
| `CORS_ORIGIN` | No | Allowed CORS origin (default: service URL) |

## Architecture

```
Browser
  |
  |-- Firebase SDK (client-side auth: Google sign-in, token refresh)
  |
  v
Next.js App (port 3000)
  |
  |-- /api/proxy (POST) -----> Fastify Service (port 8080)
  |     |                           |
  |     |-- path allowlist          |-- Firebase Admin SDK
  |     |-- X-API-Key header        |-- 22 endpoints
  |     |-- skipContentType opt     |-- Rate limiting
  |                                 |-- Audit logging
  |
  |-- /api/health (GET) -----> /health
  |-- /api/verify (POST) ----> /verify
  |-- /api/user-lookup/[uid] -> /users/:uid
  |-- /api/batch-verify ------> /batch-verify
```

**Proxy pattern**: New pages use a single `/api/proxy` route that accepts `{ path, method, body }` and forwards to the service. A path allowlist prevents SSRF. Legacy API routes (`/api/health`, `/api/verify`, etc.) remain for backward compatibility.

**Auth flow**: Firebase client SDK handles sign-in (Google OAuth). The dashboard layout redirects unauthenticated users to the login page. Service calls use `X-API-Key` header auth (not user tokens).

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router, standalone output) | 15 |
| UI | React | 19 |
| Styling | Tailwind CSS (pure, no component library) | 4 |
| Auth | Firebase SDK | 11 |
| Language | TypeScript (strict mode) | 5 |
| Dependencies | **4 total** (react, react-dom, next, firebase) | -- |

## Build

```bash
npm run build    # TypeScript check + production build
npm run dev      # Development server (port 3000)
npm run start    # Production server
```

## Project Structure

```
src/
  app/
    api/
      proxy/route.ts          # Single proxy for all service calls
      health/route.ts          # Health check (legacy)
      verify/route.ts          # Token verify (legacy)
      user-lookup/[uid]/       # User lookup (legacy)
      batch-verify/route.ts    # Batch verify (legacy)
    dashboard/
      page.tsx                 # Overview tab
      layout.tsx               # Auth guard + nav tabs
      users/page.tsx           # User management tab
      claims/page.tsx          # Custom claims tab
      tokens/page.tsx          # Tokens & sessions tab
      email/page.tsx           # Email actions tab
      batch/page.tsx           # Batch verify (legacy)
    layout.tsx                 # Root layout + auth provider
    page.tsx                   # Login page
  components/
    nav-tabs.tsx               # 5-tab navigation bar
    json-panel.tsx             # Reusable JSON display with status dot
    health-indicator.tsx       # Auto-polling health status
    user-profile.tsx           # Token verify + user lookup
    login-form.tsx             # Email/password + Google sign-in
    batch-verify.tsx           # Batch token verification
  lib/
    api.ts                     # Server-side service client (callService)
    service.ts                 # Client-side proxy helper (callProxy)
    auth-context.tsx           # Firebase auth React context
    firebase.ts                # Firebase app initialization
```
