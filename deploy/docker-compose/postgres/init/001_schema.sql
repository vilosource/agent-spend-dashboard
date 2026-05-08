-- agent_spend_logs: durable per-turn spend log.
-- See https://github.com/vilosource/pi-extensions/blob/main/docs/design/pi-usage-reporter-DESIGN.md §5.2
--
-- One row per assistant turn, written by the OTel Collector's postgres exporter
-- from OTLP spans tagged with the agent.* attribute namespace.
--
-- This file runs on first startup only (Postgres init script convention); subsequent
-- changes ship as numbered migration files in this directory.

CREATE TABLE IF NOT EXISTS agent_spend_logs (
   id                       BIGSERIAL    PRIMARY KEY,
   ts                       TIMESTAMPTZ  NOT NULL,
   ingest_ts                TIMESTAMPTZ  NOT NULL DEFAULT now(),

   -- identity
   user_id                  TEXT         NOT NULL,
   team                     TEXT,
   machine_id               UUID         NOT NULL,
   session_id               UUID         NOT NULL,

   -- workspace
   workspace_cwd            TEXT,
   workspace_repo           TEXT,
   workspace_branch         TEXT,
   workspace_is_ci          BOOLEAN      NOT NULL DEFAULT false,

   -- model
   provider                 TEXT         NOT NULL,
   api                      TEXT         NOT NULL,
   model                    TEXT         NOT NULL,
   response_model           TEXT,

   -- harness (D8 in pi-extensions decisions log; harness-agnostic)
   harness_name             TEXT         NOT NULL,
   harness_version          TEXT,

   -- usage
   input_tokens             INT          NOT NULL,
   output_tokens            INT          NOT NULL,
   cache_read               INT          NOT NULL DEFAULT 0,
   cache_write              INT          NOT NULL DEFAULT 0,

   -- cost (always USD; convert in API if needed)
   cost_input_usd           NUMERIC(12,6) NOT NULL,
   cost_output_usd          NUMERIC(12,6) NOT NULL,
   cost_cache_read_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
   cost_cache_write_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
   cost_total_usd           NUMERIC(12,6) NOT NULL,
   -- D12: 'metered' | 'subscription' | 'unreported'
   -- Lets dashboards distinguish providers that return zero cost because they're
   -- subscription-billed (Copilot) from providers that genuinely cost zero.
   cost_estimation          TEXT         NOT NULL DEFAULT 'metered',

   -- meta
   stop_reason              TEXT,
   event_kind               TEXT         NOT NULL DEFAULT 'turn',
   environment              TEXT         NOT NULL DEFAULT 'prod',
   tenant_id                TEXT         NOT NULL DEFAULT 'default',

   CONSTRAINT cost_estimation_known CHECK (cost_estimation IN ('metered', 'subscription', 'unreported'))
);

-- Hot-path indexes per design §5.2
CREATE INDEX IF NOT EXISTS agent_spend_logs_user_ts        ON agent_spend_logs (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS agent_spend_logs_team_ts        ON agent_spend_logs (team, ts DESC) WHERE team IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_spend_logs_repo_ts        ON agent_spend_logs (workspace_repo, ts DESC) WHERE workspace_repo IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_spend_logs_model_ts       ON agent_spend_logs (model, ts DESC);
CREATE INDEX IF NOT EXISTS agent_spend_logs_provider_ts   ON agent_spend_logs (provider, ts DESC);
CREATE INDEX IF NOT EXISTS agent_spend_logs_session       ON agent_spend_logs (session_id);
CREATE INDEX IF NOT EXISTS agent_spend_logs_ts            ON agent_spend_logs (ts DESC);
CREATE INDEX IF NOT EXISTS agent_spend_logs_environment   ON agent_spend_logs (environment, ts DESC);
CREATE INDEX IF NOT EXISTS agent_spend_logs_harness_name  ON agent_spend_logs (harness_name, ts DESC);

-- Materialised view for "last 14 days" hot queries (per design §5.4).
-- Refreshed on a cron in the API service or by the seeder after seeding.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_recent_spend AS
SELECT
   date_trunc('day', ts)        AS day,
   user_id,
   team,
   workspace_repo,
   provider,
   model,
   harness_name,
   environment,
   cost_estimation,
   SUM(input_tokens)            AS input_tokens,
   SUM(output_tokens)           AS output_tokens,
   SUM(cache_read)              AS cache_read,
   SUM(cache_write)             AS cache_write,
   SUM(cost_total_usd)          AS cost_usd,
   COUNT(*)                     AS turns
FROM agent_spend_logs
WHERE ts >= now() - INTERVAL '14 days'
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
WITH NO DATA;

CREATE INDEX IF NOT EXISTS mv_recent_spend_day_user ON mv_recent_spend (day, user_id);
CREATE INDEX IF NOT EXISTS mv_recent_spend_day_team ON mv_recent_spend (day, team);
CREATE INDEX IF NOT EXISTS mv_recent_spend_day_repo ON mv_recent_spend (day, workspace_repo);

COMMENT ON TABLE agent_spend_logs IS
  'One row per assistant turn from any harness emitting OTel GenAI + agent.* attributes.';
COMMENT ON COLUMN agent_spend_logs.cost_estimation IS
  'metered=provider returned per-token cost; subscription=tokens reported but cost zero (e.g. Copilot); unreported=both zero (aborted/error). See pi-extensions decisions log D12.';
