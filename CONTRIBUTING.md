# Contributing

Thanks for your interest. This is a small, opinionated repository — please read the conventions before opening a PR.

## Before you open a PR

1. Read [`AGENTS.md`](AGENTS.md). It applies to humans too.
2. Read the relevant strategy doc in [`docs/strategy/`](docs/strategy/) for context.
3. If your change introduces a new architectural decision, also append an entry to [`docs/strategy/decisions-LOG.md`](docs/strategy/decisions-LOG.md).

## Cross-repo discipline

This repository is **harness-agnostic**. Per-harness extensions (e.g. for pi) live in their own repos like [`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions). This repo's input is OTLP with `agent.*` attributes; if you find yourself wanting to special-case a specific harness here, push the fix to that harness's per-harness extension repo instead.

## Boundary

This is a public repository. Real organization names other than `vilosource`, real FQDNs, real tokens, real Vault paths, and similar values must not appear in source. The denylist in [`scripts/check-public-boundary.sh`](scripts/check-public-boundary.sh) enforces this on every PR. See [`docs/strategy/public-boundary-STRATEGY.md`](docs/strategy/public-boundary-STRATEGY.md) for the full rules.

If you hit a false positive, add the file to [`.boundary-allowlist`](.boundary-allowlist) with a one-line justification, in the same PR.

## Commits

- One logical change per commit.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Reference issues with `closes #N` / `fixes #N` when applicable.
- Stage explicit paths only; never `git add -A` or `git add .`.

## Branches

- Feature branches off `main`: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- We never open PRs directly to `main` from automated agents — humans review first.
- No force pushes to `main`. No `git reset --hard` on shared branches.

## Diagrams

All diagrams use Mermaid, rendered inline in Markdown. See [`AGENTS.md`](AGENTS.md) for the conventions.

## Code

This repository currently contains documentation only. Implementation lands as separate PRs once the lab strategy and per-component designs are agreed.

## Questions

Open an issue. We'll respond when we can.
