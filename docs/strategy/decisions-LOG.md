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

**Decision:** The local development and CI testing environment is a single Docker Compose stack at `deploy/docker-compose/` with `compose.yml` (production-shaped) and `compose.override.yml` (lab-only ergonomics). Compose profiles map to the dashboard's Shape 1 / Shape 2 / Shape 3 backend variants. A separate light containerized pi target image at `lab/pi-test/` loads the in-development extension and emits real OTLP events to the lab's Collector. Real Anthropic Haiku is used for scenario tests (not a mock provider). Dex is the mock OIDC IdP. Synthetic OTLP emitter seeds dashboards. Scenarios are YAML in `lab/scenarios/`. CI runs `make e2e` on every PR.

**Scope:** This repo. Lab files land at `deploy/docker-compose/`, `lab/pi-test/`, `lab/seed/`, `lab/scenarios/`.

**Rationale:** The full reasoning is in [`local-lab-STRATEGY.md`](local-lab-STRATEGY.md). Two principles drive the shape: (1) the dashboard is a multi-component system with no useful subset, so iteration requires all backends running locally; (2) the lab is also the smallest viable production deployment recipe, so writing it twice would be wasteful — `compose.yml` serves both purposes.

The containerized pi target solves the "poisoning" problem of testing extension changes against the developer's real pi instance. Vafi's containerized-pi work is referenced for proven patterns (mount strategy, identity injection) but a separate light image is built rather than reusing vafi's, because the test-target use case differs from autonomous-fleet execution.

Real Haiku over a mock provider: a typical scenario costs fractions of a cent and exercises the real `Usage.cost` calculation in pi-mono. CI key has a low monthly cap.

Pi-mom is out of scope for the lab (mirrors [pi-extensions D7](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/decisions-LOG.md)).
