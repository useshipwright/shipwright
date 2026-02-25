<p align="center">
  <a href="https://shipwright.build">
    <img src="logo.svg" width="80" alt="Shipwright" />
  </a>
</p>

<h3 align="center">Shipwright</h3>

<p align="center">
  Describe what you need. Get a production service that works.
  <br />
  <a href="https://shipwright.build"><strong>shipwright.build</strong></a>
</p>

---

Shipwright is an AI pipeline that reads a PRD, builds the service, runs the tests, audits for production failures, and fixes what breaks.

This repo is where we publish complete builds so you can read the output yourself. No pipeline internals. No prompts. Just the input and the output. Some evidence fields in spec artifacts are truncated from the full pipeline output.

We picked Firebase Auth as the first published build because it is small enough to read end to end. 211-line PRD, 4 endpoints, one microservice.

## Builds

| Build | Input | Output | Tests | Lines | Cost |
|-------|-------|--------|-------|-------|------|
| [Firebase Auth](builds/firebase-auth/) | 211-line PRD | Token verification microservice | 354 | 8,257 | ~$14 |

## What you will find in each build

```
builds/<name>/
  prd.md            # The spec that went in
  service/          # The code that came out
  decisions/        # Architecture Decision Records
  spec/             # Discovery artifacts (threat model, test plan, API contract)
  dashboard/        # Demo app that proves it works
  scripts/          # Deploy to GCP in one command
```

## Quick start

```bash
cd builds/firebase-auth/service
docker compose up -d --build
bash scripts/smoke-test.sh
```

12 checks against 4 endpoints. Uses the Firebase Auth Emulator. No credentials needed.

## Learn more

- **Website**: [shipwright.build](https://shipwright.build)
- **How it works**: [shipwright.build/how-it-works](https://shipwright.build/how-it-works)
- **Pricing**: [shipwright.build/pricing](https://shipwright.build/pricing)
- **Contact**: luke@cleerconsulting.com

## License

MIT
