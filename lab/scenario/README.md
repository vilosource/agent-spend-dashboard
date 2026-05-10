# `lab/scenario` — end-to-end scenario harness

Drives a real `pi` turn (with a real LLM provider) inside a Docker
container with `pi-usage-reporter` loaded as a pi extension, pointed at
the lab API's `/v1/traces` endpoint. Asserts that the resulting OTLP
span lands as a row in `agent_spend_logs` with the right shape.

**Why this exists.** The test suite (`vitest run`) covers the API in
isolation — pure transforms, requireAuth middleware, /me/* SQL — using
testcontainers + hand-crafted JWTs. Those tests prove the *server*
works. They do not prove that **a real reporter, talking real OTLP, on
the real network**, lands rows the SPA can render. That contract is
what this harness covers.

This is the agent-spend equivalent of mykb's `scripts/spike/kb-spike` +
`experiments/<name>/scenarios/`. Pattern intentionally similar; image
and verbs scaled down.

## Layout

```
lab/scenario/
├── Dockerfile              node:20-slim + pi-coding-agent + reporter OTel deps
├── entrypoint.sh           writes ~/.pi/agent/settings.json, execs `pi -p`
├── scenarios/              each *.sh defines intent / prepare / stimulate / observe
└── runs/                   per-run output dir: log, pi-stdout, pi-stderr, result.txt
scripts/scenario            operator harness CLI (build / list / run / mint)
scripts/lib/scenario-helpers.sh   helpers sourced into scenario subshell
```

## Quickstart

```bash
make lab                              # if not already running
scripts/scenario build                # one-time: build the image
scripts/scenario list                 # see available scenarios
scripts/scenario run 01-pi-zai-real-turn
```

The first run takes ~10 s (image is hot, real LLM call dominates).

A passing run prints `verdict: PASS` and writes a result record under
`lab/scenario/runs/<scenario>-<ts>/`.

## How a scenario works

Each scenario is a bash file with up to four phases. The harness
sources it into a subshell where helpers (`scenario_use_user`,
`scenario_run_pi`, `assert_*`) are already defined.

```bash
intent "real pi+zai turn lands a real row in agent_spend_logs"

prepare() {
   scenario_use_user "lab-admin@example.invalid"   # forge JWT, mint bearer
   scenario_pre_count                              # snapshot row count
}

stimulate() {
   scenario_run_pi "Reply with exactly 'ready' and nothing else."
}

observe() {
   assert_new_rows 1
   assert_latest_row_field "provider" "zai"
   assert_latest_row_field "model"    "glm-4.6"
}
```

Phases default to no-ops, so a scenario can omit any of them.

## Helpers (in `scripts/lib/scenario-helpers.sh`)

| Helper                                  | Use in     | What it does                                                           |
|-----------------------------------------|------------|------------------------------------------------------------------------|
| `scenario_use_user <email> [label]`     | prepare    | Forge session JWT, POST `/api/me/tokens`, stash bearer + email         |
| `scenario_pre_count`                    | prepare    | Snapshot current row count for the scenario user                       |
| `scenario_run_pi <prompt> [args...]`    | stimulate  | `docker run` the scenario image; reporter posts to lab API on flush    |
| `assert_new_rows <min>`                 | observe    | Polls Postgres up to ~10 s for `>= min` new rows                       |
| `assert_latest_row_field <f> <v>`       | observe    | Latest row's `<f>` equals `<v>` (exact)                                |
| `assert_latest_row_field_nonempty <f>`  | observe    | Latest row's `<f>` is non-empty + non-zero                             |

## Network + auth contract

- The container joins the existing lab compose network
  (`agent-spend_default` by default) so the reporter reaches the API
  at `http://api:8080/v1/traces` over service DNS — no host port needed.
- Identity flows entirely through the JWT minted via `/api/me/tokens`.
  The reporter sets `agent.user.id` from `git config user.email` inside
  the container, but the API drops that and uses JWT claims (D8/D13).
- LLM provider keys are passed in via env from the harness:
  - `ZAI_API_KEY` — default; falls back to `~/.pi/agent/auth.json`'s `.zai.key`
  - `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN` — set as needed and
    pass `PI_PROVIDER=...` when invoking.

## Bypassing Dex for token issuance

Mint scenarios don't run a real OIDC flow. `scripts/scenario mint` forges a
session JWT signed with `LAB_JWT_SECRET` (the lab default
`lab-jwt-secret-not-for-production`) and POSTs `/api/me/tokens` as that user.
The user must already exist in the `users` table — log in via the SPA at least
once, or rely on the bootstrap rule (first login becomes admin).

This shortcut is valid in the lab only. Production deployments use a
real secret and real Dex/Entra/etc; the same `/api/me/tokens` route is
authenticated, the only thing that changes is who the cookie comes from.

## Reporter dist source

The container expects the reporter's `dist/` bind-mounted at
`/opt/reporter/dist`. The harness defaults to:

```
${HOME}/GitHub/pi-extensions/packages/pi-usage-reporter/dist
```

Override with `REPORTER_DIST=/some/other/path scripts/scenario run …`.

When iterating on the reporter, rebuild its `dist/` (e.g. `npm run -w
@vilosource/pi-usage-reporter build` from the `pi-extensions` repo) and
re-run the scenario — no scenario-image rebuild needed.

## Adding a scenario

1. Create `lab/scenario/scenarios/NN-description.sh` following the
   `intent` / `prepare` / `stimulate` / `observe` template above.
2. `scripts/scenario list` should now show it.
3. `scripts/scenario run NN-description` to execute.

## Common failures

| Symptom                                                        | Likely cause                                            |
|----------------------------------------------------------------|---------------------------------------------------------|
| `image agent-spend-scenario:latest missing`                    | Run `scripts/scenario build` first.                     |
| `network agent-spend_default missing`                          | Run `make lab` to bring up the lab compose stack.       |
| `reporter dist missing at /…/pi-usage-reporter/dist`           | Set `REPORTER_DIST` or build the reporter package.      |
| `mint failed for <email>`                                      | The user hasn't logged into the SPA yet (no users row). |
| `ZAI_API_KEY not set`                                          | Add it to env or to `~/.pi/agent/auth.json` `.zai.key`. |
| `pi exit=non-zero`                                             | See `lab/scenario/runs/<id>/pi-stderr`.                 |
| `expected >= 1 new rows, got 0`                                | Reporter didn't flush; check `pi-stdout` for warnings.  |
