# AGENTS.md

Rules for any agent — human or AI — working in this repository.

## Style

- Technical prose only. No emoji in commits, issues, PR comments, or code.
- Be concise. Skip cheerful filler.
- Match the surrounding code style; we use Biome for lint+format once tooling lands.

## Commits

- One logical change per commit.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Reference issues with `closes #N` / `fixes #N` when applicable.
- Never `git add -A` or `git add .` — stage explicit paths only.

## Branching

- Feature branches off `main`: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- We never open PRs directly to `main` from agents — humans review first.
- No force pushes to `main`. No `git reset --hard` on shared branches.

## Documentation

- New design decisions go under `docs/design/<component>-DESIGN.md`.
- Research briefs go under `docs/research/<topic>-RESEARCH.md`.
- Strategy / cross-cutting decisions go under `docs/strategy/<topic>-STRATEGY.md`.
- Settled small decisions go in `docs/strategy/decisions-LOG.md` (append-only).
- Always link the research that motivated a design, and the design that motivated an implementation.

## Diagrams

All diagrams in this repository's documentation use **Mermaid**, rendered inline in Markdown. Do not use ASCII art, text boxes, or external image files for architecture or flow diagrams.

Conventions:

- **Architecture and data flow** → `flowchart LR` (left-to-right). Use `subgraph` to group by trust boundary or deployment location.
- **Protocols and lifecycles** → `sequenceDiagram` with `autonumber`.
- **Database schema** → `erDiagram`.
- **State machines** → `stateDiagram-v2`.
- **Roadmaps** → `gantt`.
- **Class / type relationships** → `classDiagram`, sparingly.
- **No theme directives** in diagram source. Let GitHub render with its default theme.
- **Above each diagram, write one sentence describing what it shows** so readers in plain-text viewers still understand the intent.
- **Keep each diagram under ~40 nodes.** Split into "context" and "detail" diagrams when larger.

## Public / private boundary

This repository is **public**. Per [`docs/strategy/public-boundary-STRATEGY.md`](docs/strategy/public-boundary-STRATEGY.md):

- Real organization names (other than vilosource), real FQDNs, real tokens, real Vault paths, real cloud-resource IDs **MUST NOT** appear in this repo. Use placeholders (`<organization-collector-host>`, `*.example.com`, `${ENV_VAR}`).
- A regex denylist enforces this on every push and PR (`scripts/check-public-boundary.sh`, `.github/workflows/boundary.yml`).
- If a placeholder triggers a false positive, add the file to `.boundary-allowlist` with a one-line justification, in the same PR.
- When generating examples, defer to the placeholders the rest of the repo uses. Do not invent realistic-looking FQDNs or tokens.

Organization-specific deployment values live in **private deployment repos** owned by each adopting organization, never here.

## Cross-repo discipline

This repository is **harness-agnostic**. It must not contain logic, attributes, schemas, or assumptions that are specific to one coding-agent harness (pi, Claude Code, Cursor, etc.).

- Per-harness extensions live in their own repos (e.g. [`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions) for pi).
- This repo's input is OTLP with `agent.*` attributes. Every emitter sets `agent.harness.name`; the dashboard treats them as data, not as code paths.
- A change request that says "for harness X we need to special-case Y in the dashboard" is a smell. Push the fix to the per-harness extension instead.

## Decisions log

Settled architectural decisions are recorded append-only in [`docs/strategy/decisions-LOG.md`](docs/strategy/decisions-LOG.md). New decisions go at the bottom; old ones are never edited (corrections are new entries that supersede the old). Reference an existing entry by its date and decision number (e.g. "per D1 in the decisions log") rather than re-arguing the question.
