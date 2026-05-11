# Lab OIDC IdP

A tiny purpose-built OIDC provider for the local lab — replaces the old Dex
deployment (Dex's static-password connector can't emit the app-role claims the
token-tracker server reads; see `docs/design/token-tracker-redesign-DESIGN.md`
§4). `server.mjs` is ~280 lines, zero npm deps (`node:crypto` signs the RS256
JWTs), runs on `node:slim`.

It issues exactly the token shape the API verifies: an RS256-signed access
token with `iss`, `aud` (= the API's `TOKEN_TRACKER_OIDC_CLIENT_ID`), `exp`,
`nbf`, `preferred_username` / `email`, and a `roles` array. Three hardcoded
lab identities:

| email | roles | maps to |
|---|---|---|
| `lab-admin@example.invalid`  | `["TokenTracker.Admin"]`  | admin (all rows) |
| `lab-user@example.invalid`   | `["TokenTracker.User"]`   | user (own rows) |
| `lab-viewer@example.invalid` | `["TokenTracker.Viewer"]` | viewer (own rows) |

No passwords — every identity is a placeholder; the whole stack is bound to
localhost.

## Endpoints

- `GET /.well-known/openid-configuration`, `GET /jwks`
- `GET /authorize` — PKCE auth-code flow (the SPA's MSAL flow). With no
  `?login=` it serves a one-click identity picker; clicking redirects back to
  `redirect_uri` with `?code=…`.
- `POST /token` — `authorization_code` (+ PKCE), `refresh_token`, and the
  device-code grant.
- `POST /device_authorization` + `GET /device?user_code=…` — RFC 8628 device
  flow (for the eventual `token-tracker` CLI), with a one-click approval picker.
- `POST /lab/token` — **non-spec, lab convenience.** `?user=<email>` (or
  `?role=admin|user|viewer`) returns an access token directly, no flow — for
  the scenario harness and ad-hoc `curl` testing.
- `GET /healthz`

## Config (env)

- `ISSUER` — the `issuer` claim (and the `authorization_endpoint` / `token_endpoint`
  base). It's what the browser uses, so the lab sets it to `http://localhost:7019`
  (MSAL.js only accepts an `http://` authority when the host is `localhost`). The
  discovery doc's `jwks_uri` is caller-relative (`http://<request Host>/jwks`), so
  a caller reaching the IdP via a different host (e.g. compose DNS) still gets a
  fetchable keys URL while the `issuer` stays fixed.
- `API_AUDIENCE` — the `aud` stamped on access tokens. Default `token-tracker-api`;
  must equal the API's `TOKEN_TRACKER_OIDC_CLIENT_ID`.
- `PORT` — default `5556`.

## In the lab

`compose.override.yml` runs this as the `idp` service. The browser reaches it
at `http://localhost:7019` (host port mapping); the api container reaches it at
`http://idp:5556` (compose DNS — `TOKEN_TRACKER_OIDC_ISSUER_URL`) to fetch the
discovery doc, whose `issuer` is still `http://localhost:7019` and whose
`jwks_uri` comes back as `http://idp:5556/jwks` so the api can fetch the keys.

**MSAL.js requires an `https://` authority** (no `localhost` exception), so the
SPA's browser login flow can't run against this HTTP IdP — the `/me` page shows
a "SPA login needs an HTTPS IdP" note. Everything else works over HTTP: the API
verifies these tokens, `/v1/traces` ingest works (`make smoke`), and the
scenario harness uses `/lab/token` below. To exercise the SPA login locally,
point `VITE_TOKEN_TRACKER_AUTHORITY` at an HTTPS IdP (an Entra dev tenant, or
this IdP behind a trusted-cert proxy).

Get a bearer from the shell:

```bash
curl -s -X POST http://localhost:7019/lab/token -d user=lab-user@example.invalid | jq -r .access_token
# or: scripts/scenario mint lab-user@example.invalid
```
