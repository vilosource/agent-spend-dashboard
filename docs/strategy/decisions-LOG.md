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
