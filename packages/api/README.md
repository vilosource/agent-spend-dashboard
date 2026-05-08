# `@vilosource/agent-spend-api`

The Agent Spend API + SPA + OTLP ingest service. **Private package** — not published to npm.

Single Express service that serves three URL spaces behind one TCP port:

| URL prefix | Serves |
|---|---|
| `/` | Svelte SPA static bundle (when present in `dist/spa/`) |
| `/api/*` | JSON REST (forthcoming; phases 0.3.6+) |
| `/auth/*` | OIDC flow (forthcoming; phase 0.3.3) |
| `/v1/traces` | OTLP/HTTP traces ingest (forthcoming; phase 0.3.7) |
| `/health` | `{ "status": "ok" }` for healthchecks |

See [`docs/design/api-and-spa-DESIGN.md`](../../docs/design/api-and-spa-DESIGN.md) for the full design.

## Status

Phase **0.3.1** — service skeleton. The only routes that exist are:

- `GET /health` — returns `{ "status": "ok" }`
- `GET /` — serves a placeholder HTML page until the SPA bundle lands in phase 0.3.9

Auth, REST API, OTLP ingest are deliberately not in this phase. They come in subsequent PRs per [the design doc's §11 phased delivery](../../docs/design/api-and-spa-DESIGN.md).

## Layout

```
packages/api/
├── package.json
├── tsconfig.json
├── README.md
├── Dockerfile                    used by deploy/docker-compose/compose.yml
└── src/
    ├── shared/                   pure modules (no IO)
    │   ├── version.ts            current package version (const)
    │   └── version.test.ts
    └── server/                   IO-performing layer
        ├── cli.ts                bin entry point — node ./dist/server/cli.js
        ├── app.ts                Express app factory
        ├── app.test.ts           supertest-based route tests
        └── config.ts             env-driven config
```

`src/shared/` is enforced pure by dependency-cruiser. `src/server/` is the IO layer.

## Run locally

```bash
# From repo root
npm install
npm run build          # compiles all packages
node packages/api/dist/server/cli.js
```

In the lab Compose stack, the `api` service builds from this directory's Dockerfile and is wired up by `make lab` (forthcoming; lands in phase 0.3.1 step C).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on |
| `PUBLIC_URL` | `http://localhost:8080` | what the API advertises (used later by OAuth callbacks) |

Auth-related env vars (`OIDC_*`, `JWT_SECRET`, `LAB_NO_AUTH`) are documented in [`docs/strategy/authentication-STRATEGY.md`](../../docs/strategy/authentication-STRATEGY.md) but not consumed yet — they land in phase 0.3.3.
