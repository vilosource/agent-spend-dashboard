# Agent Spend API + SPA — Design Document

**Document type:** Design
**Status:** Draft for review
**Date:** 2026-05-08
**Owner:** Platform / DevEx
**Companion documents:**
- Strategy: [`docs/strategy/authentication-STRATEGY.md`](../strategy/authentication-STRATEGY.md)
- Strategy: [`docs/strategy/local-lab-STRATEGY.md`](../strategy/local-lab-STRATEGY.md)
- Strategy: [`docs/strategy/dashboard-backend-STRATEGY.md`](../strategy/dashboard-backend-STRATEGY.md)
- Decisions: [`docs/strategy/decisions-LOG.md`](../strategy/decisions-LOG.md) — D6, D7, D8, D9, D10
- Cross-repo: [`pi-usage-reporter-DESIGN.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md) §6 (the original SPA scope, now superseded by this document)

---

## 1. Problem statement

### 1.1 Context

The reference dashboard server has shipped its first visible surface — three pre-built Grafana dashboards rendering against the `agent_spend_logs` table populated via a Python bridge that tails OTel Collector output. This solves "I want to see something on the dashboard" for org-wide and team-level views.

It does not solve four other things that were always part of the design (per the original [pi-usage-reporter design §6](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md)):

1. **Per-user RBAC** — every developer should see only their own data by default.
2. **Authoritative identity** — today, `agent.user.id` is whatever string the extension wrote (read from `git config --global user.email`). Anyone could forge any identity. Fine for a lab; not fine for any deployed environment.
3. **Self-service install** — onboarding a developer to telemetry is currently a multi-step manual config edit. It should be one command from a logged-in dashboard.
4. **Finance-grade exports and audit trail** — none exist today.

The bridge between Collector and Postgres also remains a kludge ([D4](../strategy/decisions-LOG.md)). The plan was always to retire it once a proper API existed; this document is that plan.

### 1.2 What this document specifies

A single Express service in TypeScript that:

- Serves a Svelte SPA at `/` for human users (login, dashboards, install, settings).
- Exposes JSON REST endpoints under `/api/` for the SPA to consume.
- Receives OTel Protocol traces at `/v1/traces` from pi extensions (replacing the OTel Collector + bridge path on the production deployment).
- Authenticates users via OIDC against any compliant IdP (Entra, Google, GitHub, Dex, others) per the [authentication strategy](../strategy/authentication-STRATEGY.md).
- Issues per-user, per-machine, revocable JWTs as the extension's bearer token.
- Validates JWTs on OTLP ingest; identity in `agent_spend_logs.user_id` comes from the JWT, not from extension input.

### 1.3 What this document does not specify

- The pi-test container — see [`local-lab-STRATEGY.md`](../strategy/local-lab-STRATEGY.md) §5 (separate concern; lands in its own PR).
- The CI scenario suite — same.
- Production deployment specifics for any organization (Optiscan or otherwise) — those live in private deployment repos.
- Multi-IdP federation in a single deployment — out of scope; one deployed instance speaks to one IdP. Federation lives one layer up in the IdP itself.
- Memory of past sessions / chat history / tool-call detail — never. The privacy floor in [`pi-usage-reporter-DESIGN.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md) §7 holds: only token counts, costs, model metadata, identity, workspace metadata leave the developer machine.

### 1.4 Constraints

- **C1 — Single binary.** API + SPA + OTLP ingest in one service. Reduces operational surface; matches how every comparable tool ships (Grafana, Sentry, Datadog Agent).
- **C2 — Backend-agnostic auth.** The same code path serves Entra, Google, GitHub, Dex, and any other OIDC IdP. Zero application changes when an organization plugs in their own IdP. (Per [authentication-STRATEGY.md](../strategy/authentication-STRATEGY.md).)
- **C3 — Identity comes from JWT claims.** Extensions cannot forge identity. The current `git config user.email` fallback is removed. (Recorded as D8.)
- **C4 — Bridge retired.** The OTel Collector + Python bridge path used by the lab today is replaced on the production deployment by direct OTLP ingest at the API. The Collector remains optional in the lab to exercise the standard OTel pipeline. (Recorded as D6 — sunsets [D4](../strategy/decisions-LOG.md).)
- **C5 — Privacy floor unchanged.** No prompt content, tool arguments, or file contents leave the developer machine. The API rejects any incoming OTLP attribute that could carry payload (`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool_arguments`).
- **C6 — Reversible install.** Whatever the install flow writes, the uninstall flow undoes. No cruft on developer machines.

### 1.5 Success criteria

1. **S1** — A new developer can log into the SPA via SSO and reach a populated "My Usage" page in under 2 minutes.
2. **S2** — A new developer can install pi-usage-reporter from the SPA's "Install" page in under 60 seconds, with their identity asserted by the API (not by `git config`).
3. **S3** — An admin can revoke a developer's machine token from the SPA; within 60 seconds the extension on that machine stops being able to write to the dashboard.
4. **S4** — The `agent_spend_logs` table never receives a row whose `user_id` was not asserted by a valid, non-revoked JWT.
5. **S5** — Lab developers can run the full stack (`make lab && make seed`) and reach the SPA at `http://localhost:7080` without any external IdP dependency.
6. **S6** — The bridge container is removed from the production-recipe Compose file; the lab still runs the Collector for OTel pipeline tests, but the production path is API-direct.


## 2. High-level architecture

### 2.1 The one-service picture

The API + SPA + OTLP ingest is **one Express process**. Three URL spaces live behind one TCP port:

```mermaid
flowchart LR
   subgraph dev["Developer machine"]
      pi["pi + pi-usage-reporter"]
      browser["browser"]
   end

   subgraph deploy["Deployed infrastructure"]
      direction TB
      api["Agent Spend API + SPA<br/>:8080<br/><br/>/ → SPA static bundle<br/>/api/* → REST<br/>/auth/* → OIDC<br/>/v1/traces → OTLP ingest"]
      pg[("Postgres<br/>agent_spend_logs<br/>+ users, api_tokens,<br/>budgets, audit_log")]
      idp["IdP<br/>(Entra / Google /<br/>GitHub / Dex / ...)"]
      graf["Grafana<br/>(complementary;<br/>org/team views)"]

      api <--> pg
      api -.->|OIDC| idp
      pg --> graf
   end

   pi -->|"OTLP/HTTP<br/>Bearer JWT"| api
   browser -->|"HTTPS<br/>session cookie"| api
   browser -.->|OIDC redirect| idp
```

Three URL spaces, same process:

| URL prefix | Serves |
|---|---|
| `/` | Svelte SPA static bundle (HTML + JS + CSS). The browser loads this once, then talks to the API for data. |
| `/api/*` | JSON REST. Every endpoint requires a valid session cookie or bearer JWT. |
| `/auth/*` | OIDC flow (login, callback, device-flow, logout, token issue). |
| `/v1/traces` | OTLP/HTTP traces ingest. Bearer JWT required. Identity comes from the JWT, not from request body. |
| `/health` | `{ "status": "ok" }` for compose / k8s healthchecks. |

### 2.2 Component lineup, deployed

What the deploying organization runs:

| Component | Required? | Notes |
|---|---|---|
| **API + SPA** (this service) | yes | The new service this document specifies |
| **Postgres** | yes | Spend log + auth tables |
| **IdP** | yes | Any OIDC-compliant; deploying organization's choice |
| **Grafana** | optional | Complementary; the deploying organization's existing instance, with our dashboard JSON imported |
| **Prometheus / Mimir** | optional | If the deploying organization wants metrics (the API can emit metrics to Prometheus remote-write) |
| **OTel Collector** | optional | Lab-only by default per [D6](../strategy/decisions-LOG.md). Production deploys point pi straight at the API. |

### 2.3 Component lineup, lab

What `make lab` brings up:

```mermaid
flowchart LR
   subgraph laptop["Developer laptop"]
      pi["pi + pi-usage-reporter"]
      browser["browser"]
   end

   subgraph compose["docker compose"]
      direction TB
      api["api<br/>:8080"]
      pg[("postgres<br/>:5432")]
      dex["dex (mock OIDC)<br/>:5556"]
      grafana["grafana<br/>:3000"]
      collector["collector<br/>:4318<br/>(retained: exercises OTel<br/>pipeline; not on production path)"]
      bridge["bridge.py<br/>(retained as long as<br/>Collector retained)"]

      api --> pg
      api -.OIDC.-> dex
      pg --> grafana
      collector --> bridge --> pg
   end

   pi -->|OTLP, Bearer JWT|api
   browser --> api
   browser -.OIDC.-> dex

   pi -.->|"alternative path<br/>(retained for OTel<br/>pipeline tests)"| collector
```

The Collector + bridge stay in the lab override file as an optional second OTLP path that exercises the standard OTel pipeline (filter, redact, batch, export) — useful for catching pipeline regressions before they hit organizations that *do* run a Collector. Production-recipe `compose.yml` does not include them.

### 2.4 Data flow on the OTLP hot path

```mermaid
sequenceDiagram
   autonumber
   participant Pi as pi-usage-reporter
   participant API as Agent Spend API
   participant Auth as Auth middleware
   participant DB as Postgres

   Pi->>API: POST /v1/traces<br/>Authorization: Bearer <jwt>
   API->>Auth: validate token
   Auth->>DB: SELECT api_tokens WHERE token_hash=$1<br/>AND revoked_at IS NULL AND expires_at > now()
   DB-->>Auth: row or empty
   alt token valid
      Auth->>Auth: extract claims (sub, email, machine)
      Auth-->>API: identity := { user_id, machine_id }
      API->>API: parse OTLP body, run filter/sanity, attributes/redact
      API->>API: for each span: build row with user_id from JWT (NOT from span attributes)
      API->>DB: INSERT INTO agent_spend_logs (...)
      DB-->>API: ok
      API-->>Pi: 200 {"partialSuccess": {}}
   else token invalid / revoked
      Auth-->>API: 401
      API-->>Pi: 401 Unauthorized
   end
```

The load-bearing step is **#7**: the row's `user_id` is set from the JWT's `sub` claim, **not** from the `agent.user.id` attribute the extension sent. The extension's claim is logged for audit but never used as identity ground truth.


## 3. Authentication

The full auth model is in [`docs/strategy/authentication-STRATEGY.md`](../strategy/authentication-STRATEGY.md). This section names the implementation pieces and their boundaries.

### 3.1 Library + provider matrix

| Concern | Library | Notes |
|---|---|---|
| OIDC client (Entra, Google, Okta, Auth0, Cognito, Keycloak, Dex, ...) | [`openid-client`](https://github.com/panva/node-openid-client) v6 | One library, one code path. Functional API: `client.discovery()` returns a `Configuration`. |
| GitHub OAuth (special case per [auth strategy §4.2](../strategy/authentication-STRATEGY.md)) | small custom adapter (~30 LOC) | After token exchange, `GET https://api.github.com/user` for identity. |
| JWT minting + validation | [`jose`](https://github.com/panva/jose) | HS256 signing with `AGENT_SPEND_JWT_SECRET`. Standard claims: `sub`, `email`, `name`, `role`, `teams`, `machine`, `iat`, `exp`. |
| Session cookies | `cookie` (parser) + `jose` (mint/verify) | `HttpOnly`, `SameSite=Lax`, `Secure` in prod. Cookie carries the same JWT used as a bearer token. (We don't pull in `cookie-session`; the cookie is stateless and we set/clear it directly.) |
| Stored-token hashing | `node:crypto` SHA-256 | Tokens are high-entropy random values (HS256-signed JWTs); SHA-256 is the right primitive — deterministic for O(1) row lookup, fast on the request path, and entropy makes brute force infeasible. **Not** bcrypt: bcrypt's random salt makes deterministic lookup impossible (the previous draft of this doc was wrong on this point). See D14. |

### 3.2 Auth state at the API

Two distinct token shapes live behind one JWT format. **Browser sessions** are stateless: the cookie carries an HS256-signed JWT, the API verifies the signature on each request, and there is no `api_tokens` row. **Machine tokens** (per-device, named, long-lived) DO get a row — the row is what makes them per-device-revocable.

```
┌──────────────────────┐
│ users                │     created on first OIDC callback;
│  id PK (BIGSERIAL)   │     `role` default 'developer'.
│  email UNIQUE        │
│  name                │
│  role                │
│  team_id             │
│  created_at          │
│  updated_at          │
│  last_seen_at        │
└──────────────────────┘
       │
       │ 1..N (machine tokens only)
       ▼
┌──────────────────────┐
│ api_tokens           │     one row per machine token (CLI / CI / install
│  id PK (BIGSERIAL)   │     one-liner). Browser sessions DO NOT appear here
│  user_id FK          │     — they're stateless cookies, validated by JWT
│  token_hash          │     signature alone. (D14.)
│  label               │
│  expires_at          │     token_hash = SHA-256(jwt) hex; deterministic so
│  created_at          │     the request path can look up by hash in O(1).
│  last_used_at        │     Tokens are high-entropy (HS256 JWTs ≥ 256 bits);
│  revoked_at          │     SHA-256 with no salt is correct here. (D14.)
└──────────────────────┘
```

**Why browsers don't get rows.** The strategy doc's earlier draft created a row per browser login (one per cookie clear, incognito tab, mobile login...) for the sake of per-device revocation. Net effect: write amplification on every login, accumulating dead rows after the 24h TTL, and no real value — browser sessions aren't named, individually meaningful, or worth revoking individually. If a user wants to "log everywhere out", we rotate `AGENT_SPEND_JWT_SECRET` (heavy) or — future improvement — bump a `token_version` claim on the user row (light). Either way, browser revocation isn't a per-row problem. (D14.)

**Why machine tokens DO get rows.** Per-device revocation is the value prop ("revoke `alice-laptop` without affecting `alice-desktop`"). They're named explicitly, issued once, long-lived (90d), low-volume (3-5 per developer), and the row is what holds the revocation state. (D9, refined by D14.)

### 3.3 The auth middleware

The middleware accepts the same JWT in either transport (cookie for browsers, `Authorization: Bearer` for extensions) but takes one of two paths after signature-verify based on which transport delivered it:

```typescript
// src/server/auth/middleware.ts (sketch)
import { createHash } from "node:crypto";

export async function requireAuth(req, res, next) {
   const { token, source } = bearerOrCookie(req);   // source: "cookie" | "bearer"
   if (!token) return res.status(401).json({ error: "no token" });

   let claims;
   try {
      claims = await jwtVerify(token, secret);
   } catch {
      return res.status(401).json({ error: "invalid token" });
   }

   if (source === "cookie") {
      // Browser session — no DB row to consult. JWT signature + expiry are
      // sufficient. Identity comes straight from the claims.
      req.identity = { userId: claims.sub, email: claims.email, role: claims.role,
                       tokenName: "browser", source };
      return next();
   }

   // Bearer token — must have a non-revoked, non-expired api_tokens row.
   const hash = sha256Hex(token);
   const row = await db.oneOrNone(
      `SELECT id AS token_id, user_id, label, expires_at, revoked_at
         FROM api_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [hash],
   );
   if (!row) return res.status(401).json({ error: "revoked or expired" });

   // v1: inline UPDATE. Open question §12 — batching lands when /v1/traces
   // ingest in 0.3.7 makes per-request UPDATE measurable.
   await db.none(
      `UPDATE api_tokens SET last_used_at = now() WHERE id = $1`,
      [row.token_id],
   );

   req.identity = { userId: row.user_id, email: claims.email, role: claims.role,
                    tokenName: row.label, source };
   next();
}

function sha256Hex(s: string): string {
   return createHash("sha256").update(s).digest("hex");
}
```

**Why two paths look like one, and why that's fine.** Both transports carry the same JWT format, both validate the same signature, and both attach the same `req.identity` shape. The only behavioural difference is whether we consult `api_tokens`. That keeps every downstream handler — `requireAuth` consumers don't care which transport authenticated the user — uniform.

**`last_seen_at` v1 is inline.** The design doc's open question §12 worried about per-request `UPDATE` traffic. For 0.3.6 we ship the inline write; in 0.3.7 (when extensions actually start hitting `/v1/traces` at potentially-high QPS) we measure it and decide whether to batch via in-memory queue + periodic flush or via Postgres `LISTEN/NOTIFY`. The cost of getting it wrong now is at most one extra `UPDATE` per request through the auth middleware on the SPA — the SPA's QPS is bounded by user clicks. (D14.)

Three routes that bypass auth:
- `/health` — for healthchecks
- `/auth/*` — login itself can't require auth
- `/` and `/static/*` — the SPA bundle is public; the SPA shows a login prompt if the API returns 401

### 3.4 OIDC flow implementation

Per [auth strategy §3](../strategy/authentication-STRATEGY.md). One important detail: the OIDC discovery happens at API startup, not per-request. Failing discovery is a fatal startup error so misconfigured deployments fail loud:

```typescript
// src/auth/oidc.ts (sketch)
let oidcClient: Client | null = null;

export async function configureOidc(cfg: Config): Promise<void> {
   if (cfg.LAB_NO_AUTH) {
      console.warn("[auth] LAB_NO_AUTH=true — skipping OIDC. Lab use only.");
      return;
   }
   if (cfg.OIDC_PROVIDER === "github") {
      // GitHub adapter; see §3.5
      return;
   }

   // Standard OIDC (Entra, Google, Okta, Auth0, Cognito, Keycloak, Dex, ...).
   const issuer = await Issuer.discover(cfg.OIDC_ISSUER_URL);
   oidcClient = new issuer.Client({
      client_id: cfg.OIDC_CLIENT_ID,
      client_secret: cfg.OIDC_CLIENT_SECRET,
      redirect_uris: [`${cfg.PUBLIC_URL}/auth/callback`],
      response_types: ["code"],
   });
}
```

### 3.5 GitHub adapter

GitHub does not issue an OIDC ID token. The flow:

```typescript
// src/auth/github.ts (sketch)
async function githubLogin(req, res) {
   const state = randomBytes(16).toString("hex");
   req.session.oauthState = state;
   const url = new URL("https://github.com/login/oauth/authorize");
   url.searchParams.set("client_id", cfg.GITHUB_CLIENT_ID);
   url.searchParams.set("redirect_uri", `${cfg.PUBLIC_URL}/auth/callback`);
   url.searchParams.set("scope", "read:user user:email");
   url.searchParams.set("state", state);
   res.redirect(url.toString());
}

async function githubCallback(req, res) {
   if (req.query.state !== req.session.oauthState) {
      return res.status(403).send("state mismatch");
   }
   // Exchange code for token (server-to-server)
   const token = await fetchGitHubToken(req.query.code);
   // GitHub's identity endpoint
   const user = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}` },
   }).then((r) => r.json());
   const emails = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `token ${token}` },
   }).then((r) => r.json());
   const primary = emails.find((e) => e.primary && e.verified)?.email ?? user.email;
   await issueOurJwt(req, res, {
      sub: String(user.id),
      email: primary,
      name: user.name ?? user.login,
   });
}
```

This is the only `if (provider === ...)` branch. Every other IdP runs through the standard `openid-client` flow.

### 3.6 Lab modes

Three modes per [auth strategy §5](../strategy/authentication-STRATEGY.md):

| Mode | Trigger | Behaviour |
|---|---|---|
| **Production OIDC** | `OIDC_ISSUER_URL` points at a real IdP | Standard flow; identity from IdP |
| **Lab Dex** | `OIDC_ISSUER_URL=http://idp:5556` | Same code path; identity from Dex's hardcoded users |
| **Lab no-auth** | `LAB_NO_AUTH=true` | Auth middleware short-circuits; every request is `lab-developer@example.invalid` with role `admin` |

The lab Compose override sets `OIDC_ISSUER_URL=http://idp:5556` by default. To get the no-auth mode, set `LAB_NO_AUTH=true` in the override or via `make lab LAB_NO_AUTH=true`.


## 4. Authorization

### 4.1 Three roles

Per the original design §6.2 of [pi-usage-reporter-DESIGN.md](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md):

| Role | Sees | Default for |
|---|---|---|
| `developer` | Own data only | New users on first login |
| `team_lead` | Own + own team's data | Set by an admin |
| `admin` | Everything; can edit users, teams, budgets | First user to log in (bootstrap); set by another admin thereafter |

### 4.2 Enforcement at the SQL boundary

Authorization is enforced **server-side, in the SQL `WHERE` clause**, derived from the authenticated identity. No row-level Postgres permissions; the API is the only writer of WHERE clauses, and tests cover that the right clauses fire for each role.

```typescript
// src/auth/scope.ts (sketch)
export function rowScope(req: Request): { sql: string; params: unknown[] } {
   const { userId, claims } = req.identity;
   if (claims.role === "admin") {
      return { sql: "TRUE", params: [] };
   }
   if (claims.role === "team_lead") {
      return {
         sql: "(user_id = $1 OR team = $2)",
         params: [userId, claims.team],
      };
   }
   return { sql: "user_id = $1", params: [userId] };
}
```

Every API endpoint that queries `agent_spend_logs` calls `rowScope(req)` and AND-s the result into its WHERE. Tests assert this.

### 4.3 First-user-becomes-admin bootstrap

On first OIDC callback, if the `users` table is empty, the new user is created with `role='admin'`. Subsequent users are `role='developer'` by default. Admins promote others via the SPA's admin page.

This bootstrap is documented in the deployment recipe and is the standard pattern for self-hosted multi-user tools.

## 5. API surface

### 5.1 Routes table

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/auth/login` | GET | none | Start OIDC flow; redirect to IdP |
| `/auth/callback` | GET | none | OIDC callback; mint our JWT, set cookie |
| `/auth/logout` | POST | session | Clear session cookie; revoke session token |
| `/auth/device/start` | POST | none | RFC 8628 device flow start |
| `/auth/device/poll` | POST | none | RFC 8628 device flow poll |
| `/auth/device/<code>` | GET | none | Browser arm of device flow (user pastes code, SSOs) |
| `/api/me` | GET | required | `{ user_id, email, name, role, team, machines: [...] }` |
| `/api/me/usage` | GET | required | own usage rolled up by day |
| `/api/me/sessions` | GET | required | own sessions, paginated |
| `/api/me/sessions/<id>` | GET | required | turn-by-turn detail for one session |
| `/api/me/tokens` | GET | required | list own non-revoked tokens |
| `/api/me/tokens` | POST | required | mint a new per-machine token (returns once) |
| `/api/me/tokens/<id>` | DELETE | required | revoke a token |
| `/api/team/<team>` | GET | team_lead+ | team rollup |
| `/api/team/<team>/members` | GET | team_lead+ | per-member breakdown |
| `/api/admin/users` | GET | admin | all users |
| `/api/admin/users/<id>` | PATCH | admin | edit role / team / disabled |
| `/api/admin/teams` | GET / POST / PATCH / DELETE | admin | manage teams |
| `/api/admin/budgets` | GET / POST / PATCH / DELETE | admin | manage budgets |
| `/api/admin/audit` | GET | admin | audit log |
| `/api/admin/export` | GET | admin | CSV/Parquet export with filters |
| `/v1/traces` | POST | bearer JWT | OTLP/HTTP traces ingest |
| `/health` | GET | none | `{ status: "ok" }` |
| `/install/<token-id>` | GET | bearer JWT | the install one-liner script (returned as `text/x-shellscript`) |
| `/install.json/<token-id>` | GET | bearer JWT | the JSON config snippet alternative |

### 5.2 Pagination, filtering, time ranges

Standard query params on every list endpoint:

| Param | Default | Purpose |
|---|---|---|
| `?from=` (ISO 8601) | now − 7d | start of time range |
| `?to=` (ISO 8601) | now | end of time range |
| `?limit=` | 100 | page size |
| `?cursor=` | — | opaque pagination cursor (we use `(ts, id)` ordering) |
| `?model=` | — | filter to one model |
| `?provider=` | — | filter to one provider |
| `?harness=` | — | filter by `harness_name` |
| `?environment=` | — | filter by `environment` (e.g. exclude `lab`) |
| `?cost_estimation=` | — | filter to `metered` / `subscription` / `unreported` |

### 5.3 The OTLP ingest endpoint in detail

```
POST /v1/traces
Authorization: Bearer <jwt>
Content-Type: application/json
```

Body: standard OTLP JSON traces payload (RFC-style; what `@opentelemetry/exporter-trace-otlp-http` sends).

Server processing per request:

1. Validate bearer JWT (auth middleware §3.3).
2. Parse OTLP body.
3. **Strip any payload-shaped attributes** from spans before processing (`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool_arguments`, `gen_ai.tool_call.arguments`). Defense in depth — the extension shouldn't send these but we don't trust it.
4. For each span:
   - Skip if missing `agent.harness.name` or any required attribute (warn, don't error).
   - Build a row with `user_id` from the JWT's `sub`/`email` claim, **not** from `agent.user.id` in the span.
   - Insert into `agent_spend_logs`.
5. Return `200 {"partialSuccess":{}}` per OTLP spec.

OTLP responses include `partialSuccess` with rejected counts when applicable; we use this to report dropped spans to the extension's log without failing the whole batch.

### 5.4 Install one-liner endpoint

`GET /install/<token-id>` returns a bash script (Content-Type: `text/x-shellscript`) that:

1. Detects platform (Linux / macOS / WSL).
2. Ensures `~/.config/pi-usage/` exists.
3. Writes `~/.config/pi-usage/config.json` with the endpoint, token (embedded server-side), user_id, and machine name.
4. Detects whether `~/.pi/agent/settings.json` exists; if so, patches it to add the extension path.
5. Runs `npm install -g @vilosource/pi-usage-reporter@<pinned-version>`.
6. Prints next steps.

The token is rendered into the script server-side, never displayed in the SPA after the install page closes. This means losing the install link = losing the token; users get a fresh one by clicking Install again.

`GET /install.json/<token-id>` returns the same data as a JSON snippet for users who prefer to inspect what they're pasting.


## 6. SPA pages

The Svelte SPA has these pages. The set is intentionally small for v1; growth is iterative.

| Route | Audience | Purpose |
|---|---|---|
| `/` | unauthenticated | Login button; if already authenticated, redirect to `/me` |
| `/me` | developer+ | Own usage: cost / tokens / model mix / sessions list, scoped to current user |
| `/me/sessions/<id>` | developer+ | Turn-by-turn detail for one session (own session, or admin viewing) |
| `/team/<team>` | team_lead+ | Team rollup: per-member breakdown, daily timeseries, model mix |
| `/admin` | admin | Org-wide overview |
| `/admin/users` | admin | User list, role/team management, disable, view-as |
| `/admin/teams` | admin | Team management |
| `/admin/budgets` | admin | Budget rules and alert routing |
| `/admin/audit` | admin | Audit log of admin actions and view-as events |
| `/admin/export` | admin | CSV/Parquet export with filters |
| `/install` | developer+ | Privacy preview + install one-liner |
| `/settings/tokens` | developer+ | List own tokens, revoke individually |
| `/settings/profile` | developer+ | Display name; redaction preferences (`PI_USAGE_REDACT_PATHS` toggle) |

### 6.1 Tech stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **Svelte 5** | Smaller bundle than React; good Tailwind ergonomics; no JSX. |
| Styling | **Tailwind CSS 4** | Standard; no custom CSS framework to maintain. |
| Charts | **uPlot** for timeseries; **Chart.js** for piecharts | uPlot is the fastest non-WebGL chart library for the timeseries patterns we have; Chart.js is the path of least resistance for the few non-timeseries panels. |
| Build | **Vite** | Standard for Svelte; fast dev mode. |
| Routing | **svelte-spa-router** or hand-rolled | We have ~15 routes; simple. |
| State | local stores per page; one auth store; otherwise no global state | The data is read-only and pulled per-page via fetch. No need for Redux-class state management. |

### 6.2 Page-by-page content

**`/me` (My Usage)**

```
┌─────────────────────────────────────────────────┐
│ Welcome, alice@example.com                       │
│ ─────────────────────────────────────────────    │
│ [Last 7 days ▾]                                  │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ $X.XX    │ │  N turns │ │ M tokens │         │
│  └──────────┘ └──────────┘ └──────────┘         │
│                                                  │
│  Daily cost (timeseries chart, by model)         │
│                                                  │
│  Recent sessions (table; click row → /me/...)    │
│                                                  │
│  Model mix (pie chart)                           │
└─────────────────────────────────────────────────┘
```

**`/me/sessions/<id>` (Session detail)**

A vertical timeline of every turn in the session, each row showing model, tokens in/out, cost, duration, stop reason. Useful for "why did this session cost $40" — exactly the question Grafana can't answer because Grafana doesn't know the user owns the session.

**`/install` (Install)**

```
┌─────────────────────────────────────────────────┐
│ Install pi-usage-reporter on this machine        │
│                                                  │
│ Machine name: [____________________]             │
│                                                  │
│ When you run pi, this extension will send:       │
│  ✓ Your identity (alice@example.com via SSO)     │
│  ✓ Model + provider per turn                     │
│  ✓ Token counts and cost estimate                │
│  ✓ Git repo and branch                           │
│  ✗ NEVER prompt content / tool args / files      │
│                                                  │
│ Token valid 90 days, revocable any time.         │
│                                                  │
│ ┌─────────────────────────────────────────┐     │
│ │ curl -fsSL https://...token-id... | bash│     │
│ │                            [Copy]        │     │
│ └─────────────────────────────────────────┘     │
│                                                  │
│ Prefer to inspect first? [Show JSON config]     │
└─────────────────────────────────────────────────┘
```

**`/settings/tokens`**

Table of (name, created_at, last_seen_at, expires_at, [Revoke]). One row per active token; revoking sets `revoked_at` server-side; the row stays for audit.

## 7. OTLP ingest path — replacing the bridge

Per [D6](../strategy/decisions-LOG.md), the API absorbs the bridge.

### 7.1 What the bridge did

Today (lab): `bridge.py` tails `spans.jsonl` written by the Collector's file exporter, parses OTLP JSON, and INSERTs into `agent_spend_logs`. ~150 lines of Python with no auth, no schema validation beyond skipping spans missing required attributes.

### 7.2 What the API does instead

`POST /v1/traces` directly. The processing is the same as the bridge plus auth:

```mermaid
flowchart LR
   req["POST /v1/traces<br/>Bearer JWT"] --> auth["Auth middleware<br/>(§3.3)"]
   auth -->|valid| parse["Parse OTLP body"]
   auth -->|invalid| reject401["401 Unauthorized"]
   parse --> redact["Strip payload-shaped attrs<br/>(prompt, completion, tool_args)"]
   redact --> filter["Drop spans missing<br/>required attributes"]
   filter --> identity["Set user_id from JWT claims<br/>(NOT from span attributes)"]
   identity --> insert["INSERT INTO agent_spend_logs<br/>(per span)"]
   insert --> ack["200 partialSuccess"]
```

### 7.3 Differences from the bridge

| Aspect | Bridge today | API tomorrow |
|---|---|---|
| Auth | none | bearer JWT, validated against `api_tokens` |
| Identity source | span's `agent.user.id` attribute | JWT's `sub` claim — extension's claim ignored |
| Failure mode | Collector keeps queueing to JSONL; bridge resumes on restart | Extension gets 401 → its WAL holds events → retry |
| Privacy | Collector's `attributes/redact` processor + bridge's filter | API's redact + filter; same effect |
| Persistence guarantee | Collector + bridge restart-safe | API in-memory; extension WAL is the source of truth across API outages |
| Schema validation | Skip-if-missing-required | Same |

### 7.4 Lab-only Collector retention

**Sunset complete (phase 0.3.8, commit [`8aba953`](https://github.com/vilosource/agent-spend-dashboard/commit/8aba953)).** The Collector + bridge are gone from the production-recipe `compose.yml`. They live in `compose.override.yml` only and are run by `make lab` alongside the API. The production-vs-lab split per `docker compose config`:

| Service | `compose.yml` (prod) | `compose.override.yml` (lab) |
|---|---|---|
| `postgres` | yes | (env overrides) |
| `api` | yes | (env overrides + extra_hosts) |
| `grafana` | yes | (env overrides + port) |
| `collector` | — | yes (regression fixture) |
| `bridge` | — | yes (regression fixture) |
| `idp` (Dex) | — | yes (lab IdP) |
| `seeder` | — | yes (profile-gated) |

The Collector + bridge stay in the lab as regression fixtures for the standard OTel pipeline (filter / redact / batch / file exporter). They catch behaviour drift if a deploying organisation chains the API behind their existing Collector. The seeder still drives traffic through them in `make seed`, so we exercise the full pipeline on every `make reset`.

This realises the sunset condition documented in [D6](../strategy/decisions-LOG.md) (which itself sunset [D4](../strategy/decisions-LOG.md)). The bridge is no longer load-bearing on the production path; it's pure regression infrastructure.


## 8. The install flow

Per [auth strategy §7](../strategy/authentication-STRATEGY.md) and the original design doc's CLI section.

### 8.1 Three install paths, one config file

All three paths produce the same `~/.config/pi-usage/config.json`:

```json
{
   "endpoint": "https://dashboard.example.com",
   "token": "eyJhbGc...",
   "machine_name": "alice-laptop"
}
```

The extension reads only this file; identity is in the token, not in env vars or git config.

### 8.2 Path A — SPA (interactive, default)

```mermaid
sequenceDiagram
   participant U as Developer
   participant SPA as SPA /install
   participant API as API
   participant Term as terminal

   U->>SPA: log in via SSO (already done)
   U->>SPA: fill machine name, click Generate
   SPA->>API: POST /api/me/tokens<br/>{ name }
   API->>API: mint JWT, hash, store in api_tokens
   API-->>SPA: { token_id, install_url }
   SPA-->>U: show curl one-liner with install_url
   U->>Term: paste, run
   Term->>API: GET /install/<token-id><br/>(authenticated by token-id alone — single-use)
   API-->>Term: bash script with token embedded
   Term->>Term: run script: write config, npm install, patch settings.json
```

### 8.3 Path B — Lab / `pi-usage login --lab`

For the local lab, no SSO. The CLI generates a self-signed lab token and writes the config:

```bash
pi-usage login --lab --endpoint http://localhost:7080
# → writes ~/.config/pi-usage/config.json with a lab token
```

### 8.4 Path C — CI / explicit token

For CI runners, an admin generates a long-lived token in the SPA, names it `ci-runner-<env>`, and stores it as a CI secret:

```yaml
# .github/workflows/something.yml
env:
   PI_USAGE_TOKEN: ${{ secrets.AGENT_SPEND_CI_TOKEN }}
   PI_USAGE_ENDPOINT: https://dashboard.example.com
```

The extension reads `PI_USAGE_TOKEN` if set; otherwise reads `~/.config/pi-usage/config.json`. Either works.

### 8.5 Uninstall

```bash
pi-usage uninstall
```

Reverses the install:
1. Calls `DELETE /api/me/tokens/<id>` to revoke server-side.
2. Removes `~/.config/pi-usage/`.
3. Patches `~/.pi/agent/settings.json` to remove the extension entry.
4. Optionally `npm uninstall -g @vilosource/pi-usage-reporter` (with `--full`).

Per [C6](#14-constraints), the install is reversible. No cruft left on a developer's machine.

## 9. Database schema additions

Existing `agent_spend_logs` per [§5.2 of pi-usage-reporter-DESIGN.md](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md) stays as-is. New tables this design adds:

> **Phase 0.3.2 status (landed):** the auth tables shipped as `deploy/docker-compose/postgres/init/002_auth.sql` (commit on `feat/0.3.2-auth-schema`). The landed schema is **a simplified subset** of the aspirational design below — see notes per table. Pre-production policy: changes to these tables apply via `make reset` (drop volume + re-run init/*.sql); we adopt a real migration tool when (a) we have data we'd be sad to lose, (b) we have two environments out of sync, or (c) we need a non-additive change. The aspirational columns below land incrementally as features need them.

**v1 simplifications vs the aspirational schema:**

| Concept | Aspirational | v1 landed | Why deferred |
|---|---|---|---|
| `users.role` | `developer` / `team_lead` / `admin` | `developer` / `admin` (enum) | No team-lead UX in v1; add the enum value when it's needed |
| `users.is_disabled` | column | not present | `revoked_at` on tokens covers the urgent case; user-level disable can be added when needed |
| `teams.parent_team` / `cost_center` | columns | not present | Hierarchy + cost-center routing aren't on the v1 critical path |
| `api_tokens.token_prefix` | column for display | not present | Defer until SPA renders "recently issued" with last-4 |
| `users.user_id` / `teams.team_id` | TEXT primary keys | `BIGSERIAL` `id` (with `email` UNIQUE on users, `name` UNIQUE on teams) | Numeric PKs simplify FK joins; email/name remain natural keys via UNIQUE |
| `audit_log` | table not in original §9 | shipped, append-only enforced via DB rules | Worth shipping early because admin actions start in 0.3.6 |
| `budgets` | flat row per scope | append-only by `effective_from` (history kept) | Audit-friendly; current-budget is `MAX(effective_from) <= now()` |

The SQL below is the **aspirational** target. Read `init/002_auth.sql` for the **as-landed** v1 schema.

```sql
CREATE TABLE users (
   user_id        TEXT        PRIMARY KEY,    -- email
   display_name   TEXT,
   team           TEXT        REFERENCES teams(team_id) ON DELETE SET NULL,
   role           TEXT        NOT NULL DEFAULT 'developer'
                              CHECK (role IN ('developer','team_lead','admin')),
   created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
   last_seen_at   TIMESTAMPTZ,
   is_disabled    BOOLEAN     NOT NULL DEFAULT false
);

CREATE TABLE teams (
   team_id        TEXT        PRIMARY KEY,
   display_name   TEXT        NOT NULL,
   parent_team    TEXT        REFERENCES teams(team_id) ON DELETE SET NULL,
   cost_center    TEXT,
   created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
   token_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id        TEXT         NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
   token_hash     TEXT         NOT NULL UNIQUE,    -- bcrypt of the issued JWT
   token_prefix   TEXT         NOT NULL,            -- first 8 chars, displayable
   name           TEXT         NOT NULL,            -- e.g. 'alice-laptop', 'ci-runner'
   created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
   expires_at     TIMESTAMPTZ  NOT NULL,
   revoked_at     TIMESTAMPTZ,
   last_seen_at   TIMESTAMPTZ
);
CREATE INDEX api_tokens_user ON api_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX api_tokens_hash ON api_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE budgets (
   budget_id      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
   scope          TEXT         NOT NULL CHECK (scope IN ('user','team','org')),
   scope_id       TEXT,
   period         TEXT         NOT NULL CHECK (period IN ('daily','weekly','monthly')),
   limit_usd      NUMERIC(12,2) NOT NULL,
   alert_at_pct   INT          NOT NULL DEFAULT 90,
   notify_via     JSONB        NOT NULL,
   created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
   updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
   audit_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
   ts             TIMESTAMPTZ  NOT NULL DEFAULT now(),
   actor_user_id  TEXT,                              -- NULL for system actions
   action         TEXT         NOT NULL,             -- e.g. 'token.revoke', 'user.set_role'
   target         TEXT,                              -- e.g. token_id, user_id
   payload        JSONB,
   ip_address     INET,
   user_agent     TEXT
);
CREATE INDEX audit_log_actor_ts ON audit_log (actor_user_id, ts DESC);
```

The `api_tokens` table is the load-bearing addition for revocation: every `POST /v1/traces` does a hashed lookup and check. With the partial indexes above, this is a sub-millisecond lookup.

The `audit_log` is the answer to [success criterion S5 of the original design](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md) — every admin action and every "view as another user" event is logged.

## 10. Lab Compose changes

The lab override gains the `api`, `dex`, and (still) `bridge` services. Production recipe gets `api` + `dex`-replacement (the deploying organization's IdP). Sketch:

App-specific env vars carry the `AGENT_SPEND_` prefix so a deploying organization doesn't have to namespace generic-sounding names like `JWT_SECRET` or `OIDC_ISSUER_URL` against other apps on the same host (D13).

```yaml
# deploy/docker-compose/compose.yml
services:
   postgres: # unchanged
   api:
      build:
         context: ../..
         dockerfile: packages/api/Dockerfile
      restart: unless-stopped
      environment:
         DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
         PUBLIC_URL: ${PUBLIC_URL:-http://localhost:8080}
         AGENT_SPEND_JWT_SECRET: ${AGENT_SPEND_JWT_SECRET:?set AGENT_SPEND_JWT_SECRET in .env}
         AGENT_SPEND_OIDC_ISSUER_URL: ${AGENT_SPEND_OIDC_ISSUER_URL:?set AGENT_SPEND_OIDC_ISSUER_URL in .env}
         AGENT_SPEND_OIDC_CLIENT_ID: ${AGENT_SPEND_OIDC_CLIENT_ID:?set AGENT_SPEND_OIDC_CLIENT_ID in .env}
         AGENT_SPEND_OIDC_CLIENT_SECRET: ${AGENT_SPEND_OIDC_CLIENT_SECRET:?set AGENT_SPEND_OIDC_CLIENT_SECRET in .env}
         AGENT_SPEND_LAB_NO_AUTH: ${AGENT_SPEND_LAB_NO_AUTH:-false}   # phase 0.3.5
      depends_on:
         postgres:
            condition: service_healthy
      ports:
         - "8080:8080"
```

```yaml
# deploy/docker-compose/compose.override.yml additions
services:
   api:
      environment:
         PUBLIC_URL: http://localhost:7080
         AGENT_SPEND_JWT_SECRET: lab-jwt-secret-not-for-production
         AGENT_SPEND_OIDC_ISSUER_URL: http://idp.localhost:7019
         AGENT_SPEND_OIDC_CLIENT_ID: agent-spend
         AGENT_SPEND_OIDC_CLIENT_SECRET: lab-secret
      # idp.localhost resolves to loopback on the host (RFC 6761) and via
      # host-gateway in the api container; one canonical issuer URL works
      # on both sides so OIDC's issuer-claim verification succeeds.
      extra_hosts:
         - "idp.localhost:host-gateway"

   idp:   # Dex (lab IdP)
      image: ghcr.io/dexidp/dex:v2.41.0
      command: ["dex", "serve", "/etc/dex/config.yaml"]
      volumes:
         - ../../lab/idp/dex-config.yaml:/etc/dex/config.yaml:ro
      ports:
         - "7019:5556"

   # bridge + collector retained for OTel pipeline tests; not on production path.
```

Removing the bridge's autostart and reducing its role to "Collector pipeline test" is a small change to the override; details in the implementation PR.


## 11. Phased delivery

Within this design, a sensible build order. Each phase is a separate PR landing on `main` with the earlier phases as dependencies.

```mermaid
gantt
   title API + SPA — phased delivery
   dateFormat YYYY-MM-DD
   axisFormat %b %d
   section Foundation
   0.3.1 service skeleton (express + svelte build)  :done, p1, 2026-05-08, 1d
   0.3.2 Postgres migrations + auth tables           :done, p2, 2026-05-08, 1d
   section Auth
   0.3.3 OIDC flow against Dex                       :active, p3, after p2, 3d
   0.3.4 GitHub adapter                              :p4, after p3, 1d
   0.3.5 LAB_NO_AUTH escape hatch                    :p5, after p3, 1d
   0.3.6 JWT minting + api_tokens table              :p6, after p3, 1d
   section Ingest
   0.3.7 OTLP /v1/traces ingest                      :p7, after p6, 2d
   0.3.8 retire bridge from prod compose             :p8, after p7, 1d
   section UI
   0.3.9 SPA: Login + /me page                       :p9, after p7, 3d
   0.3.10 SPA: /install + token mgmt                  :p10, after p9, 2d
   0.3.11 SPA: /team and /admin pages                 :p11, after p9, 3d
   0.3.12 SPA: /me/sessions/<id> drilldown            :p12, after p9, 1d
   section Hardening
   0.3.13 audit_log + admin export                    :p13, after p11, 2d
   0.3.14 Device-flow login (RFC 8628) for terminals  :p14, after p10, 2d
   0.3.15 pi-usage CLI: login/logout/whoami           :p15, after p14, 2d
   1.0.0 GA: full smoke + first-time onboarding test  :p16, after p15, 2d
```

Total estimate: ~25 working days. The path from "OIDC works" to "I can see my own data on the SPA" is the first 8 days (p1 through p9).

## 12. Open questions

These are deliberately unresolved in this document. Each gets settled in the relevant phase's PR.

1. **JWT signing algorithm.** HS256 is simple but means anyone with `JWT_SECRET` can mint tokens; if the deploying org wants asymmetric, RS256 is straightforward. v1: HS256. Deploying organizations who want RS256 raise it.
2. **CORS policy.** SPA and API are same-origin (one binary, one port), so CORS is not strictly needed for the SPA. But the OTLP ingest is hit by extensions on developer machines; do we need CORS on `/v1/traces`? Probably not (extensions use bearer auth, not cookies), but TBD when implementing.
3. **Rate limiting.** A pi extension can in theory emit thousands of OTLP requests if an autonomous agent goes wild. Per-token rate limits in Postgres? In Redis? In an in-memory token bucket? v1: in-memory with periodic eviction; revisit if scale forces it.
4. **Background job runner for `last_seen_at` updates.** Doing one UPDATE per OTLP request is wasteful. Batch in-memory and flush every N seconds? Use Postgres `LISTEN/NOTIFY`? v1: in-memory queue with 5s flush.
5. **Extension version compatibility.** When the API gains a new attribute, can older extension versions still ingest? Default: yes; the API tolerates missing attributes (they're optional).
6. **Where does the SPA's static bundle live in dev?** Either Vite dev-server-proxied through the API, or built and served by Express. Per-implementation choice; not architectural.

## 13. Decisions this document commits to

1. **Single binary** — API + SPA + OIDC + OTLP ingest in one Express service. Not three.
2. **Identity from JWT claims, not extension input.** The current `git config user.email` fallback is removed. (D8 in the decisions log.)
3. **OIDC as the only auth protocol.** GitHub via OAuth + adapter. Per the [authentication strategy](../strategy/authentication-STRATEGY.md).
4. **First-class IdPs at v1: Entra, Google, GitHub, Dex.** Any other OIDC works without code changes.
5. **Per-machine tokens, revocable.** One user → many machines, each independently revocable. (D9.)
6. **Three install paths**, all producing the same `~/.config/pi-usage/config.json`: SPA (interactive), `pi-usage login --lab`, `PI_USAGE_TOKEN=...` env var. (D10.)
7. **Privacy preview before install.** SPA's Install page lists exactly what will be transmitted before the user pastes anything.
8. **Authorization in the SQL `WHERE` clause**, derived from the JWT. Three roles: developer / team_lead / admin.
9. **First-user-becomes-admin bootstrap.** First successful OIDC callback creates `role='admin'`; subsequent users default to `role='developer'`.
10. **Bridge sunsets on the production path.** Lab keeps it for OTel pipeline regression testing. (D6 — sunsets D4.)
11. **Lab default uses Dex with real OIDC**, not `LAB_NO_AUTH`. The default exercises the production code path; `LAB_NO_AUTH=true` is an explicit escape for scripted runs.
12. **Reversible install.** `pi-usage uninstall` undoes everything `pi-usage login` did.
13. **Audit log for admin actions** and "view as another user." Mandatory for v1.

---

**Document status:** under active implementation. Phased delivery in §11:
- ✅ 0.3.1 service skeleton — merged to `main` ([`345c2cc`](https://github.com/vilosource/agent-spend-dashboard/commit/345c2cc) on branch, [`2ef27f9`](https://github.com/vilosource/agent-spend-dashboard/commit/2ef27f9) merge)
- ✅ 0.3.2 auth tables — merged to `main` ([`4e8520a`](https://github.com/vilosource/agent-spend-dashboard/commit/4e8520a) on branch, [`7595b01`](https://github.com/vilosource/agent-spend-dashboard/commit/7595b01) merge)
- ✅ 0.3.3 OIDC against Dex — merged to `main` ([`63eb3a9`](https://github.com/vilosource/agent-spend-dashboard/commit/63eb3a9))
- ⏭ 0.3.4 GitHub adapter — deferred (not on the Optiscan critical path; revisit when an external-contractor scenario actually needs it)
- ✅ 0.3.6 JWT minting + `api_tokens` table reads — merged to `main` ([`7744cff`](https://github.com/vilosource/agent-spend-dashboard/commit/7744cff)). `requireAuth` middleware accepts both cookie and bearer; the bearer path validates against `api_tokens` with the SHA-256 hash + partial unique index from D14.
- ✅ 0.3.7 OTLP `/v1/traces` ingest — merged to `main` ([`47bedcf`](https://github.com/vilosource/agent-spend-dashboard/commit/47bedcf)). API absorbs the bridge: `POST /v1/traces` mounted with `requireAuth` (bearer-only, cookies rejected), pure transform mirrors `bridge.py`, batch `INSERT` into `agent_spend_logs`. D6 sunset condition met.
- ✅ 0.3.8 sunset bridge from prod compose — Collector + bridge removed from `compose.yml`; both retained in `compose.override.yml` as OTel-pipeline regression fixtures (see §7.4). The production recipe is now exactly postgres + api + grafana.
- 🟡 0.3.9 SPA: Login + `/me` page — next. The "I can see my own data" milestone.
- (0.3.5 LAB_NO_AUTH escape hatch — side-quest, can land anytime; not blocking 0.3.9.)

Each subsequent phase ships as its own PR.
