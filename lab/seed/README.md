# Seeder — synthetic OTLP emitter

A small Python script that emits realistic OTel GenAI spans + metrics directly to the lab Collector via OTLP/HTTP, populating the dashboard with ~7 days of fake usage in seconds.

Per [`local-lab-STRATEGY.md` §6.1](../../docs/strategy/local-lab-STRATEGY.md#61-synthetic-otlp-emitter-primary), the seeder feeds **through the real Collector** (not directly into Postgres) so that the same code path exercised by real pi traffic is exercised by the seed too.

## Run

```bash
pip install requests

python3 seed.py \
   --endpoint http://localhost:7018 \
   --days 7 \
   --users 10 \
   --teams 3
```

In the lab, this runs as a one-shot Compose service (`seeder`) on `make seed`.

## Identities

Synthetic users are `seed-user-{1..N}@example.invalid` across `seed-team-{a,b,c}`. Workspace `agent.environment` is set to `lab` so dashboards can filter seed data out of "real" views by default.

Models cover the providers our developers actually use:
- z.ai GLM family (`glm-4.6`, `glm-4.5-air`, `glm-5`) — `metered`
- GitHub Copilot Claude family (`claude-opus-4-7`, `claude-sonnet-4`) — `subscription`
- A few others (`gpt-5`, `gemini-2.5-pro`) — `metered`

This exercises the full `agent.cost.estimation` taxonomy.
