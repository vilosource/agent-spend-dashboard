# Design

Per-component design documents for this repository.

For the design of the **pi extension** that emits OTel events to this dashboard, see [`vilosource/pi-extensions/docs/design/pi-usage-reporter-DESIGN.md`](https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md). Sections 4-6 of that document cover the dashboard server's external contract (Collector pipeline, Postgres schema, API + SPA scope) — they will eventually be re-homed here as their own dedicated design docs once we start implementing.

Forthcoming docs (in implementation order):

| Doc | Subject |
|---|---|
| [`local-lab-STRATEGY.md`](../strategy/local-lab-STRATEGY.md) (in `docs/strategy/`) | Compose-based local lab + containerized pi target for end-to-end testing — **landed** |
| `collector-pipeline-DESIGN.md` | Collector receiver, processors, exporters in detail |
| `postgres-schema-DESIGN.md` | Full DDL, partitioning, materialised views, retention |
| `api-DESIGN.md` | Express service, routes, RBAC, SSO |
| `spa-DESIGN.md` | SPA pages, state management, charts |
| `grafana-dashboards-DESIGN.md` | Dashboard JSON inventory, panel choices |

These are intentionally separate documents — at this scope a single monolithic design.md would be unmanageable.
