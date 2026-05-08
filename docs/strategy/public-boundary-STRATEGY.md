# Public / Private Boundary

**Document type:** Strategy
**Status:** Accepted
**Date:** 2026-05-08
**Owner:** Platform / DevEx
**Related:** companion doc at [`vilosource/pi-extensions/docs/strategy/public-boundary-STRATEGY.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/public-boundary-STRATEGY.md), and the cross-repo scope strategy at [`vilosource/pi-extensions/docs/strategy/scope-and-deployment-STRATEGY.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/scope-and-deployment-STRATEGY.md)
**Enforcement:** [`scripts/check-public-boundary.sh`](../../scripts/check-public-boundary.sh) and [`.github/workflows/boundary.yml`](../../.github/workflows/boundary.yml)

## 1. Purpose

This document defines the **boundary between public artifacts and private deployment artifacts** for this repository. It is the single document anyone — human contributor or AI agent — consults to answer the question: *"Can this value go in this repo?"*

The boundary exists because the agent-spend system is split into three artifacts (per [`vilosource/pi-extensions/docs/strategy/scope-and-deployment-STRATEGY.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/scope-and-deployment-STRATEGY.md)):

1. Per-harness extensions (e.g. `vilosource/pi-extensions`) — public, organization-agnostic
2. **The reference dashboard server (this repo)** — public, organization-agnostic, harness-agnostic
3. Per-organization deployments (Optiscan's, ViloForge's, anyone else's) — private, organization-specific

This repo is artifact 2. It MUST be reusable by any organization adopting it. The third MUST contain everything the first two cannot. That is the boundary.

A companion `public-boundary-STRATEGY.md` exists in `vilosource/pi-extensions` with identical rules; the regex denylist and CI workflow are deliberately the same so anyone who has internalized one document automatically respects the other.

## 2. The rule, in one sentence

**Public artifacts contain code, documentation, and example placeholders. Private artifacts contain real values.**

If a value would identify a specific organization, expose a specific deployment, or leak a secret, it does not belong in this repo or in `vilosource/agent-spend-dashboard`. It belongs in that organization's private deployment repo.

## 3. Public artifacts — what they MAY contain

These items are explicitly allowed in `vilosource/pi-extensions` and the future `vilosource/agent-spend-dashboard`:

| Allowed | Examples |
|---|---|
| Source code, configs, docs that work for any organization | TypeScript, Postgres DDL, Collector pipeline YAML with env-var placeholders |
| The `@vilosource` and `@vilosource-internal` npm scopes | `package.json` `"name"` fields |
| The repo names `vilosource/pi-extensions`, `vilosource/agent-spend-dashboard` | README links, doc cross-references |
| Example values clearly marked as placeholders | `<organization-collector-host>`, `your-grafana.example.com`, `${ORG_FQDN}` |
| Standard reserved-for-examples domains | `*.example.com`, `*.example.org`, `*.test`, `*.invalid` (per IETF RFC 2606) |
| Public package names from the pi ecosystem | `@mariozechner/pi-coding-agent`, `@ccusage/pi`, etc. |
| Maintainer attribution in commits and changelogs | `viloforge` in `git log`, GitHub usernames in CONTRIBUTORS |
| Generic operational guidance | "use Vault for secrets", "use OIDC for SSO", "use TLS" |

## 4. Public artifacts — what they MUST NOT contain

These items are forbidden in any public artifact. CI enforces this (§6).

### 4.1 Identity and infrastructure

| Forbidden | Examples of what NOT to write |
|---|---|
| Real organization names other than `vilosource` | `optiscan`, customer names, partner names |
| Real FQDNs, hostnames, IP addresses | `*.viloforge.com`, `otel.internal.example-corp.com`, `10.x.x.x` |
| Internal-DNS suffixes | `*.internal`, `*.local`, `*.corp`, `*.lan` |
| Real cloud-resource identifiers | Azure subscription IDs, AWS account numbers, GCP project IDs, AKS cluster names |
| Real Vault paths | `secret/data/optiscan/...`, `kv/internal/...` |
| Real Docker Swarm stack/service names | `optiscan-pi-usage`, `pi-usage-prod-stack` |
| Real Kubernetes namespace, cluster, or context names | (anything Optiscan-specific) |

### 4.2 Authentication and secrets

| Forbidden | Why |
|---|---|
| API tokens, access keys, JWTs, session cookies | self-evident |
| Private keys (PEM, SSH, GPG) | self-evident |
| Database connection strings with credentials | even if the credentials are revoked |
| OIDC client secrets, IdP tenant IDs, IdP issuer URLs | identifies the organization |
| Webhook URLs with embedded tokens | self-evident |

### 4.3 Organization structure

| Forbidden | Why |
|---|---|
| Real user emails (except maintainer attribution) | identifies people working at a specific organization |
| Real team names from any organization other than vilosource | identifies the organization |
| Real org-chart data | same |
| Real budget thresholds | identifies the organization's spend posture |
| Real customer or project codenames | leaks customer relationships |

### 4.4 Examples of correct vs. incorrect

```yaml
# CORRECT — placeholder, would pass CI
PI_USAGE_ENDPOINT: "https://<organization-collector-host>"
DATABASE_URL: "postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:5432/agent_spend"
GRAFANA_URL: "https://grafana.example.com"

# INCORRECT — would fail CI
PI_USAGE_ENDPOINT: "https://otel.internal.viloforge.com"  # real FQDN
DATABASE_URL: "postgres://otel:hunter2@pg-spend:5432/agent_spend"  # real credentials
GRAFANA_URL: "https://grafana.optiscan-internal.com"  # real org + FQDN
```

```typescript
// CORRECT
const teamMap = await loadTeamMapFromConfig(process.env.TEAM_MAP_PATH);

// INCORRECT
const teamMap = {
  "alice@optiscan.com": "platform",       // real org domain in source
  "bob@viloforge.com":  "platform",       // real org domain in source
};
```

## 5. Private deployment artifacts — what they MUST contain

For each organization that deploys the reference server, a separate **private** repo holds:

| Required | Examples |
|---|---|
| The actual values for every item in §4 | real FQDNs, real Vault paths, real Postgres URL |
| Deployment recipes filled in with those values | `docker-compose.yml` referencing real images and real volumes |
| References to the public artifacts as inputs | `git submodule` of the public repo, or version-pinned `npm install`, or copy with attribution |
| Operational runbooks | DR steps, on-call, alert routing — none of which is generic |
| The organization's IdP configuration | OIDC issuer URL, client ID, scopes |
| The organization's specific team-to-user map | for `transform/team_lookup` ConfigMap |
| The organization's specific budgets | per-user, per-team thresholds |

### Private artifacts — what they MUST NOT contain

| Forbidden | Why |
|---|---|
| Modifications to the public artifacts | contribute back upstream instead; never carry a private patch |
| Forks of the public artifacts | configure them, don't fork them |
| Hardcoded values that should be in a secrets manager | if it's a secret, it goes in Vault / Azure Key Vault / etc., not in the repo |

## 6. Enforcement

The boundary is enforced **mechanically**, not just by convention. Three layers, in order of strength:

```mermaid
flowchart LR
  doc["Layer 1: documentation<br/>this strategy doc"]
  repo["Layer 2: repo separation<br/>private deployment lives elsewhere"]
  ci["Layer 3: CI check<br/>scripts/check-public-boundary.sh"]
  doc -->|aspirational| repo
  repo -->|access-controlled| ci
  ci -->|mechanical, blocks PR| green["PR can merge"]
  ci -->|forbidden pattern matched| red["PR fails"]
```

### Layer 1 — Documentation

This document. The MAY / MUST NOT lists in §3-§5.

### Layer 2 — Repository separation

The public artifacts live at `vilosource/pi-extensions` (this repo) and `vilosource/agent-spend-dashboard` (future). They are public on GitHub, MIT-licensed, accept external contributions.

Per-organization deployment artifacts live in private repos owned by that organization. For Optiscan that is an Optiscan-internal repo; for any other adopting organization it is theirs. **Vilosource does not host other organizations' private deployment repos.**

### Layer 3 — CI denylist

`scripts/check-public-boundary.sh` is a fast (~50 ms) regex-based check that searches the entire repo for forbidden patterns. It runs:

- Locally on demand: `bash scripts/check-public-boundary.sh`
- Locally as part of `npm run check` (once `package.json` exists)
- In CI on every push and pull request via `.github/workflows/boundary.yml`

If any forbidden pattern is found, the script exits non-zero and prints the offending lines. **A PR with a forbidden pattern cannot merge.**

The exact pattern list is maintained in the script. Patterns include:

| Pattern category | Example regex |
|---|---|
| Specific organization names | `\boptiscan\b` (case-insensitive) |
| Internal FQDN suffixes | `viloforge\.com`, `\.internal\b`, `\.corp\b` |
| Token-shaped strings | `ghp_[A-Za-z0-9]{36}`, `sk-[A-Za-z0-9]{32,}`, `AKIA[0-9A-Z]{16}` |
| JWT-shaped strings | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` |
| PEM private keys | `-----BEGIN [A-Z ]+PRIVATE KEY-----` |

When a pattern needs to be intentionally present (e.g. an example showing what a JWT looks like, or a doc that references `vilosource` itself), the file is added to `.boundary-allowlist` with a one-line justification.

### Adding a new pattern

When we discover a new class of value that should not appear in public source:

1. Open a PR that adds the regex to `scripts/check-public-boundary.sh`.
2. Verify CI passes on `main` (i.e. the pattern doesn't already exist anywhere it shouldn't).
3. Merge.

### Adding a file to the allowlist

When a public file legitimately needs to contain a string that matches a pattern:

1. Add the file path to `.boundary-allowlist` with a comment explaining why.
2. Open a PR; reviewer confirms the justification.
3. Merge.

## 7. The same boundary in pi-extensions

[`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions) operates under the same boundary strategy. The `scripts/check-public-boundary.sh` and `.github/workflows/boundary.yml` are kept in sync between the two repos (currently by manual copy; eventually via a shared GitHub Actions reusable workflow if the patterns diverge enough to make centralization worth it). The denylist is identical. The allowlist is per-repo.

## 8. Why CI enforcement is non-negotiable

We considered "documentation only" and rejected it. Three reasons:

1. **Tired humans paste the wrong thing.** A copy-paste from a Swarm stack into a docs example, late at night, is exactly when boundary violations happen. CI catches it before review.
2. **AI agents working in this repo can't always tell what's organization-specific.** An agent generating an example might confidently write `otel.internal.viloforge.com` because it appeared somewhere in their context. CI tells the agent (via the failed PR) that the value isn't allowed.
3. **The cost of a leak is asymmetric.** Adding a regex takes 5 minutes. Cleaning up after committing a real internal hostname (force-push, key rotation, audit) takes hours. The mechanical check is overwhelmingly worth it.

## 9. Decisions this document commits to

1. **Three-tier enforcement:** documentation, repo separation, CI denylist. CI is load-bearing.
2. **The CI denylist is the source of truth.** When in doubt, what the script forbids is what is forbidden.
3. **The allowlist is a checked-in file (`.boundary-allowlist`)**, not a code change. Adding a file to the allowlist requires PR review, same as any other change.
4. **Patterns include real organization names, internal FQDNs, internal-DNS suffixes, token-shaped strings, JWT-shaped strings, PEM private keys.** New patterns added when needed.
5. **The same boundary applies to `vilosource/agent-spend-dashboard`** when it exists. The script and workflow are shared (copy or reusable workflow).
6. **Vilosource hosts no organization's private deployment repo.** Optiscan, ViloForge, and any other adopting organization keep theirs in their own GitHub orgs.
7. **Fixing a boundary violation is a tightening, not a documentation update.** If we discover that a forbidden value slipped in, we add a pattern to the denylist *and* remove the value, in the same PR.
8. **AI agents working in either public repo are bound by this document.** [`AGENTS.md`](../../AGENTS.md) references it.
