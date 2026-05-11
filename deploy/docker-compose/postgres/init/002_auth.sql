-- Auth schema: users, teams, budgets, audit_log.
-- See docs/design/token-tracker-redesign-DESIGN.md (§4) for the auth model;
-- docs/design/api-and-spa-DESIGN.md §9 for the original table inventory (its
-- auth model is superseded — no api_tokens, no users.role).
--
-- We are pre-production with no real users. This file lands
-- alongside 001_schema.sql in the Postgres init directory; both run on first
-- startup of an empty data volume. To apply this file you must drop the
-- volume: `make reset` (which is `docker compose down -v && make lab && make seed`).
--
-- This is fine *for now* and explicitly NOT a long-term strategy. It stops
-- being acceptable when ANY of these become true:
--   1. We have a real user whose data we'd be sad to lose.
--   2. We deploy to a second environment (lab + a private deployment) that
--      gets out of schema sync.
--   3. We need a non-additive change (column rename, drop, type change).
--
-- When the first of those happens, the next phase introduces node-pg-migrate
-- (or equivalent), keeps these init/*.sql files for first-time-bootstrap, and
-- ships all subsequent changes as tracked migrations.

-- =============================================================================
-- teams
-- =============================================================================
-- Teams are rollup units for dashboard views. A user belongs to at most one
-- team (users.team_id is nullable). Teams are typically created by an admin
-- at the same time they assign users to them.

CREATE TABLE IF NOT EXISTS teams (
   id          BIGSERIAL    PRIMARY KEY,
   name        TEXT         NOT NULL UNIQUE,
   created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- =============================================================================
-- users
-- =============================================================================
-- One row per authenticated identity, lazily upserted on each authenticated
-- request from the IdP access token (email, name, oid). The server is a pure
-- resource server: it issues no tokens, so there is no `api_tokens` table.
--
-- Role is NOT stored. It is read from the token's `roles` claim every request
-- (token-tracker-redesign-DESIGN.md D7); IdP group-membership changes propagate
-- on next token refresh, so there is nothing to keep in sync here.
--
-- oid: the IdP's stable object id, when the token carries it. email stays the
--      natural key — the usage rows join on email.
-- last_seen_at: bumped on every authenticated request (a cheap idempotent upsert
--      on a tiny table — no batching needed for an internal tool).

CREATE TABLE IF NOT EXISTS users (
   id            BIGSERIAL    PRIMARY KEY,
   email         TEXT         NOT NULL UNIQUE,
   name          TEXT,
   oid           TEXT,
   team_id       BIGINT       REFERENCES teams(id) ON DELETE SET NULL,
   created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
   updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
   last_seen_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);

-- =============================================================================
-- budgets
-- =============================================================================
-- Monthly USD ceilings, scoped to either a user or a team. v1 ships only
-- monthly granularity; weekly/daily/per-provider deferred until real users
-- ask for it.
--
-- scope_type + scope_id form a polymorphic reference. We don't use a real FK
-- because the FK target depends on scope_type; CHECK constraint validates the
-- combination at the application layer (and could be tightened with a trigger
-- if real-world data shows orphan budgets becoming a problem).
--
-- effective_from: budgets can be raised mid-month; we keep the history rather
-- than UPDATE-in-place so the audit log is clean. The CURRENT budget for a
-- scope is "the row with the most recent effective_from <= now() and not
-- superseded". Application logic handles the lookup; no DB trigger needed.

CREATE TYPE budget_scope AS ENUM ('user', 'team');

CREATE TABLE IF NOT EXISTS budgets (
   id              BIGSERIAL    PRIMARY KEY,
   scope_type      budget_scope NOT NULL,
   scope_id        BIGINT       NOT NULL,
   monthly_usd     NUMERIC(10,2) NOT NULL,
   effective_from  TIMESTAMPTZ  NOT NULL DEFAULT now(),
   created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
   created_by      BIGINT       REFERENCES users(id) ON DELETE SET NULL,

   CONSTRAINT budgets_monthly_usd_nonneg CHECK (monthly_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_budgets_scope
   ON budgets(scope_type, scope_id, effective_from DESC);

-- =============================================================================
-- audit_log
-- =============================================================================
-- Append-only record of admin actions (token issuance/revocation, role
-- changes, budget edits, team assignment). The append-only invariant is
-- enforced by the rule below — UPDATE and DELETE are rejected at the DB level,
-- so any code path (including a buggy admin UI) cannot rewrite history.
--
-- details: heterogeneous JSONB. Different actions carry different payload
-- shapes; we don't try to normalize them. Indexed via GIN for ad-hoc query.

CREATE TABLE IF NOT EXISTS audit_log (
   id              BIGSERIAL    PRIMARY KEY,
   ts              TIMESTAMPTZ  NOT NULL DEFAULT now(),
   actor_user_id   BIGINT       REFERENCES users(id) ON DELETE SET NULL,
   action          TEXT         NOT NULL,
   details         JSONB        NOT NULL DEFAULT '{}'::jsonb,

   CONSTRAINT audit_log_action_nonempty CHECK (length(action) > 0)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts             ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_user_id  ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action         ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_details_gin    ON audit_log USING GIN (details);

-- Append-only enforcement: reject UPDATE and DELETE at the DB level.
-- Even with admin DB credentials a code bug cannot rewrite history.
CREATE OR REPLACE RULE audit_log_no_update AS
   ON UPDATE TO audit_log DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_log_no_delete AS
   ON DELETE TO audit_log DO INSTEAD NOTHING;

-- =============================================================================
-- updated_at trigger for users
-- =============================================================================
-- Only users has updated_at among these tables (teams is immutable enough,
-- budgets are append-only by effective_from, audit_log is rule-enforced
-- append-only).

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = now();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
   BEFORE UPDATE ON users
   FOR EACH ROW
   EXECUTE FUNCTION set_updated_at();
