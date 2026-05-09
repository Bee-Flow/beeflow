# Bee Flow — Server (`bee-flow-server`)

The Node.js + Express backend for every Bee Flow deployment. Powers chat,
agents, knowledge bases, integrations (Nextcloud, Google, Microsoft, etc.),
the automation engine, and the license gate.

> **License**: Sustainable Use Licence (fair-code). You can self-host this
> for free for your own organisation. You cannot offer Bee Flow as a paid
> service to third parties without a commercial agreement. See
> [LICENSE.md](./LICENSE.md).

## Status

Open-sourced so anyone can:
- Self-host Bee Flow at the **community tier** (single user, basic chat,
  local KB) — no license key required.
- Audit exactly what the SaaS at `api.beeflow.ai` runs on (this repo *is*
  what runs in production).
- Contribute bug fixes and integrations.

Premium features (`pro`, `enterprise`, `full`) require a license key signed
by the private Bee Flow licence-server. The validation public key
(`license/bundled-public-key.pem`) is the only key the server trusts.

## Quick start

```bash
git clone https://github.com/Bee-Flow/beeflow.git
cd beeflow
cp .env.example .env       # set DB_URL, JWT_SECRET, model API keys
docker compose up          # Postgres + Redis + Bee Flow server on :3101
```

Then open [hive](https://github.com/Bee-Flow/hive)
or run `npm install @beeflow/frontend && npx serve node_modules/@beeflow/frontend/dist`.

## Tier overview

| Tier         | Users  | Agents | Messages/mo | Premium features                         |
|--------------|--------|--------|-------------|------------------------------------------|
| `community`  | 1      | 2      | 1,000       | basic chat, local KB, NC basic           |
| `pro`        | 25     | 20     | 50,000      | + automations, webpages, meeting notes, skills, ticket assistant, voice |
| `enterprise` | unl.   | unl.   | unl.        | + DLP/guardrails, GDPR compliance hub, SAML SSO, audit log export        |
| `full`       | unl.   | unl.   | unl.        | + white-label, license issuance          |

Full feature ↔ tier mapping: [`license/tiers.js`](./license/tiers.js).

## How licensing works

```
                ┌───────────────────────────┐
                │ Bee Flow licence-server   │  (PRIVATE — Bee Flow only)
                │ Mints signed JWT licenses │
                │ ECDSA private key         │
                └─────────────┬─────────────┘
                              │ signs
                              ▼
            ┌─────────────────────────────────┐
            │ JWT (delivered by mail / dash)  │
            └─────────────────┬───────────────┘
                              │ admin pastes
                              ▼
   ┌───────────────────────────────────────────────────────┐
   │ This repo — bee-flow-server (PUBLIC)                  │
   │ Verifies JWT against bundled-public-key.pem           │
   │ requireLicenseFeature(name) middleware enforces gates │
   └───────────────────────────────────────────────────────┘
```

You can buy a license at [beeflow.ai/pricing](https://beeflow.ai/pricing).
Free / community tier is always available without a key.

## Running in production

We officially support:
- Docker (single-node): `docker run ghcr.io/bee-flow/beeflow:latest`
- Docker Compose: `deploy/docker-compose.yml`
- Kubernetes: [helm](https://github.com/Bee-Flow/helm) chart
- Coolify: `deploy/coolify.json`

See [docs/self-hosting.md](./docs/self-hosting.md) for the full runbook.

## Required services

- **PostgreSQL 16+** — primary store
- **Redis** — sessions cache, rate-limits (optional but strongly recommended)
- **At least one model provider key** — Anthropic, OpenAI, Mistral, or Azure OpenAI

## Repo layout

```
auth/              # Session, OAuth, JWT, NC connector auth
agents/            # Agent CRUD + execution
automation/        # Workflow engine (pro+)
compliance/        # GDPR / AIA tooling (enterprise+)
core/
  agentRuntime/    # Chat streaming, tool dispatch, guardrails
  betaFeatures.js  # Org-level beta-feature gates
  integrationTools.js  # Tool registry + per-org/group filtering
integrations/      # Nextcloud, Google, MS, etc.
jobs/              # Background workers (NC sync, GDPR archive, …)
license/           # JWT verification, tier definitions, middleware
routes/            # HTTP endpoints
services/          # Cross-cutting domain services
stores/            # Postgres-backed data layer
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Run `npm test` before sending a PR.

## Security

Disclose responsibly via **tomkooy@beeflow.nl**. See [SECURITY.md](./SECURITY.md).

## Trademarks

"Bee Flow" and the bee logo are trademarks of Bee Flow B.V. Forks are welcome
under fair-code; please don't ship a fork under the Bee Flow name.

## Questions

- Commercial: **tomkooy@beeflow.nl**
