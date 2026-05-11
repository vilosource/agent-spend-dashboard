# token-tracker — redesign

**Supersedes the auth model of:** [`api-and-spa-DESIGN.md`](api-and-spa-DESIGN.md) (phases 0.3.3, 0.3.6, 0.3.7's auth path, 0.3.10).

**Status:** design locked 2026-05-10 after walking decisions D1–D8 with the
operator. Pre-implementation. The pipeline shape (ingest, schema, /me page,
scenario harness) is preserved; the auth layer is replaced wholesale.

## 1. Background

Earlier iteration shipped as `agent-spend`, deployed to a single tenant's
production environment, end-to-end-tested with real OTLP telemetry. The
deploy works. The auth model does not.

Three security gaps came out of that deploy, all rooted in the same design
choice (the server mints and signs its own JWTs with a single HMAC secret):

1. A self-signed bearer JWT is also a valid session cookie. The middleware
   splits on transport, not on token type; same secret, same claim shape.
   A leaked bearer can be replayed as a logged-in admin browser session.
2. Revoking a bearer kills only the bearer transport. The cookie path
   doesn't consult `api_tokens` at all (stateless by design), so a revoked
   JWT remains valid as a cookie until its `exp` (90 days).
3. Anyone with read access to the HMAC signing secret can forge any user's
   session JWT and impersonate them. The OIDC flow through the IdP is real
   for normal users but bypassable by anyone with the secret. The trust
   anchor we *say* is the IdP is actually the secret.

Pre-launch with no real users, no data worth migrating, the right move is
a full redesign before this is something a wider audience consumes.

## 2. Goal

Make the IdP (OIDC provider) the only credential issuer the server
consumes. Every authenticated request — SPA browser, CLI reporter, future
integrations — carries a token signed by the IdP. The server verifies
signatures against the IdP's published JWKs and never signs anything
itself.

## 3. Non-goals

- Backward compatibility with the legacy bearer flow.
- Data migration from the previous deploy.
- Multi-IdP support in v1; this is single-tenant against one OIDC IdP.
- Provider-cost tracking. The name "token-tracker" is intentional; we track
  token usage. Cost is a future addition for providers that return it.

## 4. Architecture

```
                    BROWSER (SPA)                              CLI / agent harness
                          |                                            |
                          |  MSAL.js PKCE                              |  RFC 8628 device flow
                          v                                            v
                          IdP (any OIDC provider)
                          |                                            |
                          |  access_token (JWT, signed by IdP)         |  access_token + refresh_token
                          v                                            v
              Authorization: Bearer <access_token>        ~/.config/token-tracker/auth.json
                          |                                            |   (silent refresh on every flush)
                          |                                            |
                          +----------------+---------------------------+
                                           |
                                           v
                                  resource server (this codebase)
                                  - cache IdP JWKs (refresh on key rotation)
                                  - verify signature, iss, aud, exp, nbf
                                  - identity = { email, oid, roles[] }
                                  - upsert users row (lazy)
                                  - serve /api/me/*, /v1/traces, /me page, etc.
                                  - never issues a token of any kind
```

The server is a pure OAuth 2.0 resource server. There is no `/auth/login`
that starts a flow, no `/auth/callback` that exchanges codes, no session
cookies that the server signs, no bearer tokens minted by the server. The
SPA's MSAL.js library handles the auth dance entirely client-side; the
CLI's device flow handles it via the IdP directly.

### 4.1 Verifier module

A single `verifyEntraAccessToken(jwt)` function on the server, used by
both the API middleware (for `/api/*`) and the OTLP ingest (`/v1/traces`):

```ts
1. cached_jwks = await fetchAndCacheIdpJwks(issuerUrl)   // refresh on kid miss
2. { payload, kid } = jwtVerify(token, cached_jwks, { algorithms: ['RS256', 'ES256'] })
3. assert(payload.iss === expected_issuer)
4. assert(payload.aud === own_client_id)
5. assert(payload.exp > now)
6. identity = {
     email: payload.upn || payload.preferred_username || payload.email,
     oid:   payload.oid,
     roles: payload.roles ?? [],
   }
7. upsert users (email) on first sight
```

One code path. Same function consumed by SPA-originated requests and CLI-
originated requests. The cookie-vs-bearer transport split goes away.

### 4.2 SPA auth flow

`@azure/msal-browser` library, configured with the IdP authority URL and
the registered client id. PKCE flow.

Token storage is `sessionStorage` (MSAL's `cacheLocation`): cleared when
the tab closes, never written to disk, never `localStorage`, never shared
across tabs — but it survives in-tab navigation and page reloads, which
the SPA does on every route change (`/` → `/me`) and on the redirect-back
from the IdP. (This started as "in-memory only"; that turned out to be
non-functional — see D3 — every page navigation wipes an in-memory cache,
and `ssoSilent` (the intended recovery path, a hidden iframe to the IdP's
authorize endpoint) is blocked by browsers' third-party-cookie policies.
`sessionStorage` is the smallest cache that actually works with the
redirect flow.) On tab close the token is gone and the user clicks
through a fresh sign-in redirect next time. UX-equivalent to other
internal apps.

The "session cookie" the previous design issued is gone. Any state the
server needs about a user (last-seen, role-cache for analytics) lives in
the `users` table keyed by IdP `oid`.

### 4.3 CLI / reporter auth flow

A new package (see ADR D2) provides:

- `token-tracker login` — RFC 8628 device flow. Prints a user_code and
  verification_uri, polls the IdP's token endpoint, writes the resulting
  `{access_token, refresh_token, expires_at}` to `~/.config/token-tracker/auth.json`
  with mode `0600`.
- A reporter library that hooks into pi (and, in future, other harnesses)
  via the same `agent.*` OTel attribute namespace. Before each OTLP flush:
  reads the auth file, checks expiry, silently refreshes if near-expired,
  POSTs OTLP with `Authorization: Bearer <access_token>`.
- `token-tracker status` — prints whether auth is valid, the upn, when
  the refresh_token expires.
- `token-tracker logout` — wipes the auth file. Optionally hits the IdP's
  end-session endpoint.

User experience: run `token-tracker login` once per ~refresh-token-lifetime
(IdP-policy-dependent, typically 30–90 days). Between logins, every pi turn
either uses the current access token or transparently exchanges
refresh_token for a new access token in ~200ms.

### 4.4 Role-based authorization

Three roles defined in the IdP app reg: `TokenTracker.Admin`,
`TokenTracker.User`, `TokenTracker.Viewer`. Standard role-claim pattern:

- Tenant security groups (e.g., `grp-token-tracker-{admins,users,viewers}`)
  are assigned to the corresponding app roles in the Enterprise Application
  view in the IdP.
- A user's access token includes `roles: ["TokenTracker.Admin"]` if they
  are a member of the admin group.
- The API maps role claims to internal role values per request. No DB
  write needed for role changes — Entra group membership changes propagate
  on next token refresh.
- A user with no role claim → `403` with a clear "you don't have a role
  assignment for this app, ask an admin to add you to grp-token-tracker-users"
  message.
- `users.role` column is dropped. Role is sourced from the token claim
  every request.

This matches the documented pattern for OIDC apps using App Roles +
low-risk Graph permissions; no admin consent is required for the four
delegated scopes (`User.Read`, `openid`, `email`, `profile`).

## 5. ADRs

### D1 — Rename the source repo
Rename `vilosource/agent-spend-dashboard` → `vilosource/token-tracker`.
GitHub renames are instant and auto-301 the old URL for git operations
and the web UI. History stays intact. The "agent-spend" name was always
misleading (most providers don't return cost, so we never actually
tracked spend), and pre-launch is the cheapest moment to rename.

### D2 — Reshape the agent-side package
Drop the existing `@vilosource/pi-usage-reporter` package. Create
`@vilosource/pi-token-tracker` that combines the pi extension entry, the
device-flow login + refresh library, and a CLI binary `token-tracker`.
Env vars become `TOKEN_TRACKER_*` (they namespace the *backend*, not the
package, so future analogs like `claude-token-tracker` use the same env
namespace). The repo `vilosource/pi-extensions` stays as the home for
pi-side extensions.

### D3 — SPA auth shape
MSAL.js PKCE redirect flow; the server is a pure resource server, no
server-issued credentials anywhere. The legacy "server-side OIDC redirect
+ opaque session id" option was considered and rejected: it would
reintroduce "server as issuer" at smaller scale, moving the impersonation
surface from a shared secret to a `sessions` table without closing it.

**Token cache: `sessionStorage`** — revised; originally specified
"in-memory only", which is non-functional with this app. The SPA
navigates with full page reloads (`/` → `/me`, and the IdP redirect-back),
each of which wipes an in-memory MSAL cache; and the documented recovery
path — `ssoSilent`, a hidden iframe to the IdP's authorize endpoint — is
blocked by modern browsers' third-party-cookie policies (Safari/Firefox
always; Chrome/Edge increasingly). Net effect of memory-only: the token
is destroyed on the first post-login navigation and can't be recovered →
an infinite sign-in loop. `sessionStorage` survives in-tab navigation and
reloads; it's cleared on tab close, never written to disk, never
`localStorage`. (Paired with `navigateToLoginRequestUrl: false` so MSAL
doesn't add yet another page reload after the redirect handshake.)

The XSS concern (access token reachable from JS) is bounded by: (a) the
SPA being internal-only behind VPN, (b) Svelte 5's default-escape
templating, (c) no third-party scripts, (d) a `Content-Security-Policy`
header at deploy time, (e) never `localStorage`, and the token being
discarded on tab close.

### D4 — Migration strategy
Leave the existing legacy deploy running until the parallel token-tracker
deploy is verified end-to-end. Then DNS-cut the old hostname or stand
down the old stack. No data to migrate.

### D5 — Salvage scope
Aggressive salvage of non-auth code. Keep the OTLP transform module
(`packages/api/src/server/ingest/transform.ts` — pure, well-tested,
harness-agnostic by design), the `Db` interface shape, the Postgres schema
(renamed tables/columns), the SPA bundling pattern (Vite output into
`packages/api/dist/spa/`), the existing `/me` page Svelte components, the
scenario harness (`lab/scenario/`), and the integration test patterns.

Delete: the entire `packages/api/src/server/auth/` directory, the
`api_tokens` table and its Db methods, the `/api/me/tokens` route, the
HS256 + shared-secret machinery, the existing `/auth/login` and
`/auth/callback` server-side OIDC flow, the lab Dex deployment.

### D6 — Database and table naming
Database renamed `agent_spend` → `token_tracker`. The main events table
renamed `agent_spend_logs` → `usage_log` (singular, describes what it
holds, drops the misleading "spend" connotation). Other tables (`users`,
`teams`, `audit_log`, `budgets`) unchanged in name; their column shapes
evolve where the auth rewrite requires (e.g., `users.role` removed).
The OTel attribute namespace `agent.*` stays — it's the wire vocabulary,
harness-agnostic, decoupled from any backend name.

### D7 — Authorization model
Role claim from the IdP access token, mapped to internal role each request.
`users.role` column removed; the column was a redundant cache of what the
token claim already provides, and a write target that diverged from IdP
state over time. The "first user becomes admin" bootstrap is dropped — it
was a workaround for not having proper IdP role assignment; with App
Roles + group assignment, the first user is admin because their group
membership says so.

### D8 — IdP app registration
The existing `sp-agent-spend-auth-prod` app reg evolves additively. Same
`appId`. Display name updated. **Additional** redirect URIs appended (new
SPA's MSAL callback alongside the legacy server-side `/auth/callback`).
**Additional** app roles appended (`TokenTracker.Admin/User/Viewer`
alongside `AgentSpend.Admin/User/Viewer`). When the legacy deploy is
torn down later, the now-unused redirect URIs and roles are removed in a
cleanup pass.

## 6. Implementation phases

Each phase is independently committable; phases compose into a working
end state.

### Phase 0 — Design doc (this file)
This document, committed to the source repo so the design intent travels
with the code.

### Phase 1 — Rename
- GitHub repo rename via the UI.
- Local clones: `git remote set-url`.
- npm workspace package names: `@vilosource/agent-spend-{api,spa}` →
  `@vilosource/token-tracker-{api,spa}`. Reflowed across `package.json`,
  `tsconfig.*`, `vite.config.*`, and CI workflows.
- GHCR image: published as `ghcr.io/vilosource/token-tracker` on the next
  workflow run; old package can be deleted manually.
- No functional change; tests must remain green.

### Phase 2 — API auth refactor
- Delete `packages/api/src/server/auth/` (whole dir).
- Delete `packages/api/src/server/me/tokens.ts` and its tests.
- Strip `api_tokens`-related methods from the `Db` interface.
- Strip `AGENT_SPEND_JWT_SECRET`, `AGENT_SPEND_OIDC_*` from `config.ts`.
  Replace with `TOKEN_TRACKER_OIDC_TENANT_ID`, `TOKEN_TRACKER_OIDC_CLIENT_ID`.
- New module `packages/api/src/server/auth/idp.ts` providing the verifier
  and JWKs cache. Integration tests against a freshly-minted real IdP
  token (via test fixtures, not against the lab Dex; Dex goes away).
- Replace the `requireAuth` middleware with one that calls the verifier.
- Map role claims to internal role values (`TokenTracker.Admin` → `admin`,
  etc.).
- The `/auth/*` routes go away entirely; the SPA handles the IdP flow.

### Phase 3 — SPA auth refactor
- Add `@azure/msal-browser` as a dependency in `packages/spa`.
- New module `packages/spa/src/lib/auth.ts` wrapping MSAL config + token
  acquisition. Token state held in a single closure-scoped variable.
- Replace cookie-based auth in `packages/spa/src/lib/api.ts` with bearer
  authentication using the in-memory access token.
- `packages/spa/src/main.ts` bootstraps MSAL on load; redirects to the
  IdP if no valid token; once authenticated, renders the routed page.
- `Home.svelte` and `Me.svelte` keep their content; their data-fetching
  switches to the new bearer-bearing API client.

### Phase 4 — Schema migration
No live data to migrate. The new `token_tracker` database is created
fresh with the renamed tables; the existing `agent_spend` database is
left in place under the legacy deploy and dropped during cutover.

### Phase 5 — pi-token-tracker package
- New package at `vilosource/pi-extensions/packages/pi-token-tracker/`.
- Source structure mirrors the old `pi-usage-reporter` for the OTel
  emission code, plus a new `auth/` module for device flow + refresh,
  plus a CLI binary at `bin/token-tracker`.
- Tests for the refresh dance (fake IdP token endpoint).
- The old `packages/pi-usage-reporter/` directory is deleted.

### Phase 6 — Deploy the parallel stack
- A new private deployment repo (or branch) for the token-tracker
  organization deploy. Same shape as the existing legacy deploy.
- New Postgres database, new Vault path (only one key needed now —
  `database_url`), new Harbor image name, new DNS record.
- The existing IdP app reg gains the new redirect URI + new app roles
  (per D8).
- New stack deployed to the same Swarm cluster, parallel to legacy.
- Live OIDC smoke + a real OTLP turn via the new CLI.

### Phase 7 — Cutover and decommission
- Verify the parallel deploy passes the smoke ladder.
- `make remove` the legacy stack.
- Drop the legacy Postgres database, Vault path, DNS record.
- Clean up the IdP app reg: remove the legacy redirect URI and the
  `AgentSpend.*` roles.

## 7. Risks and open questions

- **MSAL.js silent renewal under blocked third-party cookies.** Some
  browser configurations block third-party cookies and break the silent
  renewal iframe. MSAL falls back to popup or redirect, but the UX is
  worse. We'll need to test in the deployment's target browsers (Edge,
  Chrome, Firefox) and document the fallback.
- **Refresh-token failure mid-pi-turn.** If a refresh fails at the
  exact moment a flush is needed, the reporter loses that flush. v1
  behaviour: log a warning, drop the spans for that batch (don't buffer
  to disk). Buffered persistence is a later enhancement if loss-rate is
  noticeable.
- **JWKs cache stale-key handling.** When the IdP rotates signing keys,
  some tokens issued under the new key arrive before our cache refreshes.
  Implementation must refresh-on-kid-miss (refetch JWKs if a token's
  `kid` isn't in cache) before declaring invalid.
- **CSP header tightening.** The deploy needs a deliberate CSP shipped
  with the SPA: `script-src 'self'`, `connect-src 'self' https://login.microsoftonline.com`.
  Misconfigured CSP will break MSAL silently; we'll need a CSP-report
  endpoint or close attention during the first browser test.

## 8. Status

| Item | Status |
|------|--------|
| Design lock (D1–D8) | done — 2026-05-10 |
| Phase 0 — this doc | done (this commit) |
| Phase 1 — rename | next |
| Phase 2 — API auth refactor | blocked on phase 1 |
| Phase 3 — SPA auth refactor | blocked on phase 2 |
| Phase 4 — schema | blocked on phase 2 |
| Phase 5 — `pi-token-tracker` | parallel to phases 2-4 |
| Phase 6 — parallel deploy | blocked on phases 1-5 |
| Phase 7 — cutover | blocked on phase 6 + smoke pass |
