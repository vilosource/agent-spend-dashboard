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
