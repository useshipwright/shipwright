# Firebase Auth Dashboard

A Next.js app that exercises every endpoint of the Firebase Auth Verification Service. Login with email/password or Google, then verify tokens, batch-verify, and look up user profiles.

## Features

- Email/password and Google sign-in via Firebase Auth
- Token verification with full claim display
- Batch token verification
- User profile lookup
- Live health indicator

## Quick start (with emulator)

```bash
cd ../service
docker compose up -d --build    # starts service + Firebase Auth Emulator

cd ../dashboard
cp .env.local.example .env.local  # if provided, or set vars below
npm install
npm run dev
```

Open `http://localhost:3000`. The emulator provides auth without real Firebase credentials.

## Configuration

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase Web API key |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase auth domain (`<project>.firebaseapp.com`) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | GCP project ID |
| `FIREBASE_AUTH_SERVICE_URL` | URL of the Firebase Auth service |

## Production deploy

The [`scripts/deploy.sh`](../scripts/deploy.sh) in the build root deploys both the service and this dashboard to Cloud Run.

## Stack

- Next.js 15
- React 19
- Firebase SDK 11
- Tailwind CSS 4
- TypeScript 5
