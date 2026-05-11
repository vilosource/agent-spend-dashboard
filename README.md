# token-tracker

Per-developer LLM spend dashboard for coding-agent harnesses.

This repository is the **reference dashboard server** for the [scope-and-deployment strategy](https://github.com/vilosource/pi-extensions/blob/main/docs/strategy/scope-and-deployment-STRATEGY.md) (canonical version lives in [`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions)). It consumes [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) plus a small `agent.*` extension namespace, and works with **any harness that emits OTel** — pi (via [`@vilosource/pi-usage-reporter`](https://github.com/vilosource/pi-extensions)), and in the future Claude Code, Cursor, Aider, or anything else that follows the same wire format.

## Status

**Phase 0.3.2 shipped.** The Compose stack (Postgres + OTel Collector + bridge + Grafana with three pre-built dashboards + API service skeleton) and the synthetic emitter all live in this repo. End-to-end verified: `make lab && make seed` brings up a working local environment in under a minute and shows real graphs at <http://localhost:7000> and a placeholder API at <http://localhost:7080>.

What's done:

- **0.1** Lab Compose stack + bridge + seeder
- **0.2** Three Grafana dashboards (Org Overview, By Team, Burn Rate)
- **0.3.1** API service skeleton: Express on `:7080` with `/health` + placeholder `/`
- **0.3.2** Auth tier schema: `users`, `teams`, `api_tokens`, `budgets`, `audit_log` (no code reads them yet — lands in 0.3.6)

What's next (per [`docs/design/api-and-spa-DESIGN.md`](docs/design/api-and-spa-DESIGN.md) §11):

- **0.3.3** OIDC against Dex (~3 days) — first real auth flow
- **0.3.4–0.3.6** GitHub adapter, lab escape hatch, JWT minting + token verification
- **0.3.7–0.3.8** OTLP `/v1/traces` ingest on the API; sunset the bridge
- **0.3.9** SPA: Login + `/me` page ("I can see my own data" milestone)
- **0.3.10–0.3.15** Token management, /team and /admin pages, drilldowns, audit export, device-flow login, `pi-usage` CLI

Roadmap details and status of each phase: [`docs/design/api-and-spa-DESIGN.md`](docs/design/api-and-spa-DESIGN.md) §11.

## What's here today

- A [local lab strategy](docs/strategy/local-lab-STRATEGY.md) describing the Compose-based development environment, containerized pi target, scenario format, and CI integration
- A [public/private boundary strategy](docs/strategy/public-boundary-STRATEGY.md) and the same boundary CI as [`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions)
- A high-level design that mirrors the [pi-usage-reporter design](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md) §4-§6 (Collector pipeline, Postgres schema, API + SPA scope)

Implementation lands as separate PRs on `main` once the lab strategy is reviewed.

## What this is not

This is **not** Optiscan's deployment of the dashboard. Optiscan's deployment lives in a private Optiscan-internal repo, fills in the organization-specific values (Docker Swarm stack, Azure Managed Postgres connection string, IdP issuer URL, real Grafana/Prometheus URLs), and is out of scope for this public repo.

This is also **not** the pi extension. The extension that emits OTel from a pi session lives at [`vilosource/pi-extensions`](https://github.com/vilosource/pi-extensions). The dashboard consumes what the extension emits; they are two artifacts with two release cycles.

## What you can do today

Run the lab:

```bash
make lab     # bring up Postgres + Collector + bridge + Grafana (~25s)
make seed    # emit ~2800 synthetic spans (~5s)
open http://localhost:7000   # browse the dashboards (anonymous viewer enabled)
make psql    # poke around the usage_log table
make clean   # tear everything down (irreversible)
```

Three dashboards are pre-loaded in the **Token Tracker** folder:

| Dashboard | Use it for |
|---|---|
| Org Overview | Org-wide cost, model mix, top spenders, metered-vs-subscription split |
| By Team | Per-team cost rollup, per-developer drill-down within team filter |
| Burn Rate | Real-time burn over the last 24 h; long-running session detector |

Log in as `admin` / `admin` to edit dashboards or add new ones (allowed in the lab; production deployments set a real password and disable anonymous viewing).

See `make help` for the full verb list. The lab uses defaults from `deploy/docker-compose/.env` (intentionally insecure placeholders for local development); a production deployment uses `compose.yml` alone with a real `.env`.

Read the docs:

| Path | Subject |
|---|---|
| [`docs/strategy/`](docs/strategy/) | Cross-cutting decisions for this repo |
| [`docs/design/`](docs/design/) | Per-component design docs (forthcoming) |
| [`docs/research/`](docs/research/) | Research briefs (forthcoming; some inherited via cross-link) |

## Architecture, in two diagrams

The big picture, from the perspective of a deploying organization:

```mermaid
flowchart LR
  subgraph dev["Developer machines"]
    pi["pi + pi-usage-reporter"]
    cc["Claude Code + future extension"]
    cur["Cursor + future extension"]
  end

  subgraph deploy["Reference dashboard server (this repo, deployed by the organization)"]
    direction TB
    col["OTel Collector"]
    pg[("Postgres<br/>usage_log")]
    api["API + SPA"]
    graf["Grafana<br/>(organization's existing instance)"]

    col --> pg
    pg --> api
    col -.->|Prometheus remote_write,<br/>optional| graf
  end

  pi  -->|OTLP| col
  cc  -.->|OTLP, future| col
  cur -.->|OTLP, future| col
```

The harness-agnostic attribute namespace, in one diagram:

```mermaid
flowchart LR
  subgraph standard["OTel GenAI standard (every emitter)"]
    direction TB
    s1["gen_ai.usage.input_tokens"]
    s2["gen_ai.usage.output_tokens"]
    s3["gen_ai.usage.cache_read.input_tokens"]
    s4["gen_ai.usage.cache_creation.input_tokens"]
    s5["gen_ai.provider.name"]
    s6["gen_ai.request.model"]
  end

  subgraph custom["agent.* extension namespace (this dashboard)"]
    direction TB
    a1["agent.user.id<br/>agent.machine.id<br/>agent.session.id"]
    a2["agent.workspace.{cwd,repo,branch,is_ci}"]
    a3["agent.cost.{input,output,cache_read,cache_write,total}.usd"]
    a4["agent.harness.{name,version}<br/>← distinguishes pi vs Claude Code vs ..."]
  end
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For agents (human or AI) working in this repo, see [AGENTS.md](AGENTS.md).
