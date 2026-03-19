<p align="center">
  <a href="https://shipwright.build">
    <img src="logo.svg" width="80" alt="Shipwright" />
  </a>
</p>

<h3 align="center">Shipwright</h3>

<p align="center">
  PRD in. Production service out.
  <br />
  <a href="https://shipwright.build"><strong>shipwright.build</strong></a>
</p>

---

Shipwright is an AI engineering pipeline that orchestrates dozens of specialized agents to turn a product spec into a production-ready service -- with tests, security hardening, deployment infrastructure, and architecture documentation.

Not a code generator. Not an autocomplete. A multi-stage pipeline where discovery agents research external APIs via web search and MCP tool connections, planning agents decompose architecture into dependency graphs with human-in-the-loop review, execution agents implement code in git-checkpointed sandboxes with mechanical rollback, and verification agents build real Docker containers, probe live endpoints, and score the output against production readiness criteria.

The pipeline scales the number of agents to match the complexity of the build, and catches its own mistakes automatically.

This repo publishes complete builds. No cherry-picking. No pipeline internals. Just the input and the output.

---

## Builds

| Build | Tasks | Failures | Tests | Endpoints | Readiness | Cost | Time |
|-------|-------|----------|-------|-----------|-----------|------|------|
| [**Firebase Auth v1.2**](builds/firebase-auth/) | 55/55 | **0** | 456 | 22 | 30/31 | $56 | 5.4h |

---

### Firebase Auth Verification Service

A 22-endpoint Fastify + TypeScript microservice for Firebase Authentication.

Token verification, user CRUD, custom claims, session cookies, batch operations, email actions. Constant-time API key auth, per-class sliding-window rate limiting, PII log redaction, structured audit trail, multi-stage Docker build, Prometheus metrics. 12 architecture decision records. Threat model with RBAC matrix and data classification.

55 tasks executed with git-checkpointed rollback. 20 issues detected and self-corrected. Zero human intervention during execution. Zero failures.

Tested against a live Firebase project -- user lookup, custom claims lifecycle, and audit log verification all confirmed working.

**[Read the full build report ->](builds/firebase-auth/)**

---

## What you will find in each build

Every build includes the **input** (PRD), the **output** (working service with tests), and the **evidence** (architecture decisions, threat model, test plan, compliance audit). You can read the spec, run the tests, build the Docker image, and deploy to GCP yourself.

```
builds/<name>/
  prd.md            # The spec that went in
  service/          # The code that came out
    src/            # Source code
    tests/          # Unit + integration + smoke tests
    Dockerfile      # Multi-stage, non-root
    scripts/        # Smoke test + integration test
  decisions/        # Architecture Decision Records
  spec/             # Discovery artifacts
    architecture.md
    threat_model.md
    test_plan.md
    api_contract.yaml
    rbac_matrix.md
    data_classification.md
  dashboard/        # Demo app that exercises every endpoint
  scripts/          # Deploy to GCP in one command
```

## Quick start

```bash
cd builds/firebase-auth/service
cp .env.example .env
docker compose up -d --build
bash scripts/smoke-test.sh
```

25 endpoint checks. All pass.

---

## Learn more

- **Website**: [shipwright.build](https://shipwright.build)
- **Contact**: luke@cleerconsulting.com

## License

MIT
