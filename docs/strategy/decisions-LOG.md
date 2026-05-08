# Decisions Log

**Document type:** Decisions Log (append-only)
**Status:** Living document
**Owner:** Platform / DevEx

This log records small, settled decisions that don't warrant their own strategy doc but should be captured so we don't relitigate them. Append-only. New decisions go at the bottom; old ones are never edited (corrections go in a new entry that supersedes the old).

For decisions that span both this repo and `vilosource/pi-extensions`, the canonical entry lives in [that repo's decisions log](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/decisions-LOG.md). This log records only decisions specific to the dashboard server.

---

## 2026-05-08 · D1 · Repository created

**Decision:** Created `vilosource/agent-spend-dashboard` as the public, harness-agnostic reference dashboard server, separate from `vilosource/pi-extensions`.

**Scope:** This repo.

**Rationale:** Per [D8 in the pi-extensions decisions log](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/decisions-LOG.md), the dashboard is harness-agnostic while the extension is per-harness. They are two artifacts with two release cycles. Putting both in one repo would couple them unnecessarily and obscure the harness-agnosticism.

This repo currently contains documentation only. Implementation lands in subsequent commits as the lab strategy and per-component designs are agreed.

---

## How to add an entry

1. Append a new section at the bottom: `## YYYY-MM-DD · D<n> · <one-line title>`.
2. Required fields: **Decision**, **Scope**, **Rationale**.
3. Old entries are never edited. To correct a decision, write a new entry that explicitly says "supersedes D<n>".
4. Commit on a feature branch; PR review confirms the decision was actually agreed; merge.

---

## 2026-05-08 · D2 · Local lab strategy

**Decision:** The local development and CI testing environment is a single Docker Compose stack at `deploy/docker-compose/` with `compose.yml` (production-shaped) and `compose.override.yml` (lab-only ergonomics). Compose profiles map to the dashboard's Shape 1 / Shape 2 / Shape 3 backend variants. A separate light containerized pi target image at `lab/pi-test/` loads the in-development extension and emits real OTLP events to the lab's Collector. **Real LLM providers are used for scenario tests** — default is **z.ai** via the Anthropic-compatible endpoint with `ANTHROPIC_AUTH_TOKEN`; optional **GitHub Copilot** via mounted OAuth state. Dex is the mock OIDC IdP. Synthetic OTLP emitter seeds dashboards. Scenarios are YAML in `lab/scenarios/`. CI runs `make e2e` on every PR. (Earlier draft of this entry incorrectly named Anthropic Haiku as the lab provider — we do not have direct Anthropic accounts; the corrected provider list is in [`local-lab-STRATEGY.md` §5.4](local-lab-STRATEGY.md). See D3.)

**Scope:** This repo. Lab files land at `deploy/docker-compose/`, `lab/pi-test/`, `lab/seed/`, `lab/scenarios/`.

**Rationale:** The full reasoning is in [`local-lab-STRATEGY.md`](local-lab-STRATEGY.md). Two principles drive the shape: (1) the dashboard is a multi-component system with no useful subset, so iteration requires all backends running locally; (2) the lab is also the smallest viable production deployment recipe, so writing it twice would be wasteful — `compose.yml` serves both purposes.

The containerized pi target solves the "poisoning" problem of testing extension changes against the developer's real pi instance. Vafi's containerized-pi work is referenced for proven patterns (mount strategy, identity injection) but a separate light image is built rather than reusing vafi's, because the test-target use case differs from autonomous-fleet execution.

Real provider over mock: real provider path exercises the real `Usage.cost` calculation in pi-mono. Both supported providers are subscription-based, so per-call cost is not a concern.

Pi-mom is out of scope for the lab (mirrors [pi-extensions D7](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/decisions-LOG.md)).

---

## 2026-05-08 · D3 · LLM provider for the lab — z.ai (default), GitHub Copilot (optional)

**Decision:** The lab uses **z.ai via the Anthropic-compatible endpoint** (`https://api.z.ai/api/anthropic` with `ANTHROPIC_AUTH_TOKEN`) as the default provider for scenario tests. **GitHub Copilot** is optionally supported (via the developer's existing OAuth state mounted RO from `~/.pi/agent/auth.json`); Copilot scenarios run locally only because OAuth device-flow doesn't fit unattended CI cleanly. CI uses z.ai exclusively.

**Scope:** This repo. Lab files (`deploy/docker-compose/`, `lab/pi-test/`, `lab/scenarios/`, GitHub Actions workflows).

**Rationale:** The previous draft of D2 named Anthropic Haiku as the lab provider. That was wrong: this organization does not have direct Anthropic accounts. The actual providers our developers and our automation (vafi) use are z.ai (subscription via the GLM Coding Plan, exposed both as an Anthropic-compatible and an OpenAI-compatible endpoint) and GitHub Copilot (subscription, OAuth-authenticated). The lab must mirror what we actually run, not a generic example provider.

vafi's [`images/developer/vf-harness/init-pi.sh`](https://github.com/vilosource/vafi/blob/main/images/developer/vf-harness/init-pi.sh) is the reference implementation for wiring pi to z.ai inside a container — the lab's `pi-test` image follows the same pattern (write `~/.pi/agent/models.json` with `api: anthropic-messages`, `apiKey: ANTHROPIC_AUTH_TOKEN`, `baseUrl: https://api.z.ai/api/anthropic`).

For GitHub Copilot the OAuth state is held in `~/.pi/agent/auth.json` on the host (a dict containing the GitHub token and the short-lived Copilot token cache). The pi-test container mounts this file RO; it does not perform the OAuth flow itself.

The "low monthly cap" guidance from D2 (which referenced Anthropic's per-key spending caps) does not apply: both z.ai's Coding Plan and GitHub Copilot are subscription-based with no per-call billing exposure to manage.

**Supersedes the relevant clauses of D2** (provider selection only). The rest of D2 (Compose stack, profiles, containerized pi target, Dex, synthetic emitter, scenario format, CI integration) stands.

---

## 2026-05-08 · D4 · Bridge service for OTLP→Postgres until the API service lands

**Decision:** The lab uses a small Python script (`lab/bridge/bridge.py`) that tails the OTel Collector's `file/spans` JSONL exporter output and `INSERT`s rows into `agent_spend_logs`. The Collector writes JSONL via the well-supported `file` exporter; the bridge does the last-hop write to Postgres. The bridge runs as a Compose service in the lab (`bridge`) and is replaced by the API service in phase 0.3.

**Scope:** This repo, lab tooling. Not part of any production deployment recipe.

**Rationale:** The OTel Collector's official `postgresql` exporter does not exist; the experimental `sqlexporter` has unstable shape and is not part of the contrib distribution most installations use. Building our own Collector exporter is not justified — phase 0.3's API service will own the database write path anyway.

The intermediate JSONL file is a clean seam:

- The Collector does what Collectors do (receive, batch, redact, fan out).
- The bridge does Postgres-specific work in a small, easily-tested script.
- If the bridge is down, the JSONL file accumulates; the bridge catches up on restart. The Collector keeps accepting traffic.
- When the API service lands, the bridge goes away — the API consumes OTLP directly via its own ingest endpoint, or via a Collector-to-API HTTP exporter. The intermediate JSONL stops being needed.

The bridge is ~150 lines of Python with stdlib + `psycopg`. No build step. Easy to read, easy to fix.

**Validated:** Lab end-to-end (2026-05-08): synthetic emitter sends 2800 spans → Collector writes JSONL → bridge inserts → 2800 rows in `agent_spend_logs` → all expected aggregations work (per-user cost, per-team rollup, per-model breakdown, subscription-vs-metered separation, materialized view refresh).

**Sunset condition:** Phase 0.3 lands the API service. When the API can ingest OTLP directly (or via a Collector OTLP exporter pointing at it), the bridge service is removed from `compose.override.yml` and the JSONL exporter from `collector/config.yaml`.

---

## 2026-05-08 · D5 · Grafana dashboards land now; SPA later

**Decision:** Add Grafana to the Compose stack as the lab's first visible UI surface, with three pre-built dashboards (Org Overview, By Team, Burn Rate) provisioned via the Grafana files API. The custom SPA originally planned for phase 0.3 still ships later for the things Grafana can't do well (per-user RBAC, finance-grade exports, custom drill-downs) — but the org/team/ops views land in Grafana now.

**Scope:** This repo. Grafana service in `compose.yml` + `compose.override.yml`; provisioned datasource and dashboards in `deploy/docker-compose/grafana/`.

**Rationale:** Per the [dashboard backend strategy](dashboard-backend-STRATEGY.md), the Shape 3 architecture uses Grafana for ops/team views and a custom SPA for per-user/finance/audit views. The two are complementary; nothing about the SPA requires Grafana to ship first or last. But Grafana is **dramatically faster to first-visible-result**: it ships dashboards as JSON, has a Postgres datasource out of the box, and provisioning is a one-file YAML config. The SPA is weeks of TypeScript.

For the explicit goal of "I want to see something on the dashboard," shipping Grafana first is the right answer. It also lets us validate the schema by querying it from a real BI tool, which surfaces ergonomic problems with column names, missing indexes, etc., before the SPA is locked into them.

The dashboards we ship today match the org/team/ops view targeted by the design doc §6 SPA pages. When the SPA lands in phase 0.3, the SPA owns: per-user (each developer sees only their own data), finance exports, audit, and any drill-down that needs a custom URL or data shape Grafana can't render. The Grafana dashboards stay; they don't compete with the SPA, they complement it.

**Validated end-to-end (2026-05-08):** `make lab && make seed` brings up the stack in ~25 s, populates 2800 rows, and Grafana renders all three dashboards correctly:
- Org Overview: total cost $9.41 across 8 model variants; subscription split visible
- By Team: $5.52 / $2.84 / $1.05 across 3 teams
- Burn Rate: long-running session detector flags 5 sessions > 23 h

---

## 2026-05-08 · D6 · API absorbs the bridge (sunsets D4)

**Decision:** The Agent Spend API service exposes `/v1/traces` as a direct OTLP/HTTP ingest endpoint, validating bearer JWTs and writing to `agent_spend_logs` directly. On the production-recipe Compose stack (`compose.yml`), the OTel Collector and `bridge.py` are removed. They remain in the lab's `compose.override.yml` to exercise the standard OTel pipeline (filter / redact / batch / export) for regression testing.

**Scope:** `compose.yml` (production recipe) and `compose.override.yml` (lab); the API service per [`docs/design/api-and-spa-DESIGN.md`](../design/api-and-spa-DESIGN.md) §7.

**Sunsets:** [D4](decisions-LOG.md) — the bridge was always meant to be temporary, with this exact sunset condition documented at the time. v1 of the API meets that condition.

**Rationale:** Three reasons to do the direct path on production:

1. The auth boundary is in one place. The API validates JWTs; the Collector would have to too if we kept it on the production path, doubling the auth surface.
2. The bridge was a Python script with no auth, no schema validation beyond skipping spans missing required attributes, and no upgrade story. The API absorbs all of those concerns into a service that's already maintained for the SPA.
3. The Collector's actual value (filter / redact / batch / fan-out to multiple backends) can be replicated trivially in the API for our specific extension because we know the schema. Production deployments that have an existing OTel Collector in front of everything can still chain ours behind it via OTLP — the API speaks OTLP, so it's interchangeable.

The lab keeps the Collector + bridge specifically to **catch regressions in the standard OTel pipeline**. If a third-party emitter ever tried to push to a deployment that does run a Collector in front, those tests are what validate the path works.

---

## 2026-05-08 · D7 · OIDC for all authentication; multi-IdP at v1

**Decision:** The reference dashboard server authenticates users via OIDC. v1 first-class targets: Entra ID, Google Workspace, GitHub (via OAuth + adapter), Dex (lab). Any other OIDC-compliant IdP (Okta, Auth0, Keycloak, AWS Cognito, AWS IAM Identity Center, etc.) works without code changes — only env vars differ.

The lab default is Dex with hardcoded users (exercises real OIDC against a real IdP). A `LAB_NO_AUTH=true` escape hatch skips auth entirely for scripted runs.

**Scope:** API service. Per the [authentication strategy](authentication-STRATEGY.md), this concern is at the strategy level rather than buried in component design because future extensions for other harnesses will reuse the same auth model.

**Rationale:** OIDC is the standard auth protocol layered on OAuth 2.0; every major IdP speaks it. One library (`openid-client`) + one code path serve every OIDC IdP. Configuration is environment variables. The application binary is identical for every deploying organization; only the env vars change.

GitHub is the only special case because GitHub's OAuth predates OIDC. Handled with a small adapter (~30 LOC) that calls `GET /user` after the token exchange.

Multi-IdP within a single deployment is out of scope — federation lives one layer up in the IdP itself.

---

## 2026-05-08 · D8 · Identity from JWT claims; `git config` fallback removed

**Decision:** The `user_id` written to `agent_spend_logs` comes from the JWT claim asserted by our API after a successful OIDC flow. The extension's `agent.user.id` attribute is no longer used as identity ground truth — it's logged for audit only.

The pi-extension's current resolution chain (`PI_USAGE_USER_ID` env → `git config --global user.email` → `${USER}@${hostname}`) is removed. Instead, the extension reads its bearer token from `~/.config/pi-usage/config.json`; identity is encoded in the token, validated and extracted by the API.

**Scope:** Both [`packages/pi-usage-reporter/src/extension/identity.ts`](https://github.com/vilosource/pi-extensions/blob/main/packages/pi-usage-reporter/src/extension/identity.ts) (resolver simplifies dramatically) and the API's auth middleware (extracts `sub`/`email` from JWT for every OTLP request).

**Rationale:** Today, anyone can forge any identity by setting `PI_USAGE_USER_ID=ceo@example.com` before launching pi. Fine for a lab; not fine for any deployed environment. With the JWT-claims model:

1. The extension's outbound OTLP request includes `Authorization: Bearer <jwt>`.
2. The API verifies the signature with `JWT_SECRET`.
3. The API looks up the token row by hash; rejects if revoked or expired.
4. The API takes `user_id` from the JWT's `sub`/`email` claim, not from any `agent.user.id` attribute the extension sent.

**Recorded as D13 in the pi-extensions decisions log** (the same decision applies on both sides of the wire).

---

## 2026-05-08 · D9 · Per-machine tokens (one user → many machines, each revocable)

**Decision:** When a developer clicks "Install" in the SPA, they name the machine ("alice-laptop", "alice-desktop", "ci-runner-prod") and the API mints a JWT scoped to (user, machine) with a 90-day TTL. Every active token has a row in `api_tokens` with a name, last-seen timestamp, and revoke button.

**Scope:** API service `api_tokens` table; SPA Settings → Tokens page; CLI `pi-usage logout` revokes the local machine's token.

**Rationale:** Reality check: a developer has 3-5 machines they use pi on, plus CI runners. Single-token-per-user means revoking the lost laptop kicks the desktop offline too. Per-machine tokens match how the user actually uses the system. Standard pattern (GitHub, Tailscale, 1Password, modern CLIs in general).

The API's auth middleware updates `last_seen_at` on every successful authenticated request, so admins can see when each machine last spoke and revoke stale tokens proactively.

---

## 2026-05-08 · D10 · Three install paths, one config file

**Decision:** All three install paths produce the same `~/.config/pi-usage/config.json` `{ endpoint, token, machine_name }`. The extension reads only that file plus the `PI_USAGE_TOKEN` env var override.

| Path | Use case | Mechanism |
|---|---|---|
| **A. SPA interactive** | normal developer onboarding | log into SPA → click Install → paste one-liner; SPA generates a per-machine JWT and embeds it in the install script |
| **B. Lab** | local lab work without SSO | `pi-usage login --lab --endpoint http://localhost:7080`; CLI mints a self-signed lab token |
| **C. CI** | CI runners and unattended machines | admin generates a long-lived token in the SPA, stores as `AGENT_SPEND_CI_TOKEN` secret; CI sets `PI_USAGE_TOKEN=$AGENT_SPEND_CI_TOKEN` |

Plus a fourth path for terminal-only login: `pi-usage login` runs the **OAuth 2.0 Device Authorization Grant** (RFC 8628) — opens a URL on the user's browser, user pastes a code, CLI polls for completion. Standard flow; works on headless / CI machines without an interactive browser on the same host.

**Scope:** API service (`/auth/device/*` endpoints, `/install/<token-id>` script renderer); pi-extensions CLI (`pi-usage login`, `pi-usage logout`, `pi-usage whoami`).

**Rationale:** One config file shape covers every case; the install path is just "how did the file get written." Making a single shape work everywhere keeps the extension simple (one code path reads config) and the SPA UI honest (Install means writing this exact file).

The privacy preview before install (Install page lists exactly what will be transmitted before the user pastes anything) is not legally required but is the kind of trust signal that costs little and is rare enough in enterprise telemetry that it's worth doing.

---

## 2026-05-08 · D11 · Lab port layout — minimum exposure on 70xx

**Decision:** Three-tier port-exposure policy for the lab Compose stack:

- **Tier 1 — always exposed (real user-facing surfaces):**
  - `7000` Grafana
  - `7080` API
- **Tier 2 — transitional, exposed with documented sunset:**
  - `7018` OTel Collector OTLP/HTTP — retires at phase 0.3.8 when the API absorbs `/v1/traces` (per D6)
- **Tier 3 — NOT exposed; in-Compose only:**
  - Postgres `:5432` → access via `make psql` (`docker compose exec`)
  - OTLP gRPC `:4317` → no consumer
  - Collector health `:13133` → `wait-healthy` reads Compose status, not a host probe

Container-internal ports stay at their defaults (`postgres:5432`, `collector:4318`, `grafana:3000`, `api:8080`) so service-to-service DNS keeps working unchanged. Only the host-side mapping changes.

**Scope:** `deploy/docker-compose/compose.override.yml`, `Makefile`, lab + design + decisions docs in both repos.

**Rationale:** The previous layout exposed six ports — three of which had no consumer outside Compose ("posti-host" already held 8080 on the dev machine; OTLP gRPC was exposed by reflex; the health endpoint existed only for the Makefile to probe, which is now done via `docker compose ps --format json`). Mixing user-facing surfaces with debug-conveniences had real cost: more port-conflict opportunities, noisy startup message, surprise attack surface. The 70xx cluster is mnemonic and free on developer machines.

**Rejected alternatives:**

- *Expose-everything (status quo):* status quo. Discarded after the Postgres question made the over-exposure obvious.
- *70xx for everything (six ports):* still noisy in the `make lab` message; doesn't separate real surfaces from debug.
- *Separate dev-mode and lab-mode overrides:* too much config surface for the size of the team.

**Verified end-to-end:** `7000`, `7018`, `7080` respond after `make lab`; `5432`, `4317`, `4318`, `13133`, `3000`, `8090` all refuse (expected). `make psql` works through Compose exec without a host port. CI green.

---

## 2026-05-08 · D12 · Schema changes via drop-and-reseed until we have data worth keeping

**Decision:** Pre-production, schema changes ship as additional or amended `init/*.sql` files in `deploy/docker-compose/postgres/init/`. To apply, drop the data volume: `make reset` (`docker compose down -v && make lab && make seed`). Phase 0.3.2 (auth tables) lands as `init/002_auth.sql` under this policy.

This is **explicitly a temporary policy** with three trigger conditions, any of which moves us to a real migration tool (`node-pg-migrate` or equivalent):

1. We have a real user whose data we'd be sad to lose.
2. We deploy to a second environment (lab + a private deployment) that gets out of schema sync.
3. We need a non-additive change (column rename, drop, type change).

When the first trigger fires, the next phase introduces the migration tool, keeps the `init/*.sql` files for first-time bootstrap, and ships all subsequent changes as tracked migrations. The policy is documented at the top of `init/002_auth.sql` itself so it can't be silently ignored.

**Scope:** `deploy/docker-compose/postgres/init/`, `Makefile` (`make reset`), `api-and-spa-DESIGN.md` §9 status note.

**Rationale:** Migration tooling earns its keep when at least one of (durable data, multi-environment, non-additive change) is true. None are true today: ~2800 rows of seeded synthetic data + a handful of `kb-pi` runs, single environment, additive changes only. Building the tooling now would be premature complexity (`pgmigrations` table, up/down migrations, runner integrated into `cli.ts`, testcontainers for migration tests). When we hit the first trigger we'll invest the day to do it right; until then, drop-and-reseed is correct.

**Rejected alternatives:**

- *Adopt `node-pg-migrate` now:* premature. Costs ~1 day; saves nothing today; the API doesn't even read these tables yet (auth middleware lands in 0.3.6).
- *Hand-rolled SQL files + 30-line runner:* same cost as a real tool, less battle-tested.
- *Skip auth tables until we have a migration tool:* couples two phases unnecessarily; auth tables can sit unused while the API skeleton evolves.

**Verified:** `make reset` re-creates all six tables (`agent_spend_logs` + `users` + `teams` + `api_tokens` + `budgets` + `audit_log`) cleanly; constraints behave (UNIQUE active label, CHECK monthly_usd >= 0, audit_log append-only via DB rules, updated_at trigger on users); seed re-emits 2800 rows; Grafana dashboards render unchanged.
