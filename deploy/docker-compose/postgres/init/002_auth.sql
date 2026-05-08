-- Auth schema: users, teams, api_tokens, budgets, audit_log.
-- See https://github.com/vilosource/agent-spend-dashboard/blob/main/docs/design/api-and-spa-DESIGN.md §9
--
-- Per phase 0.3.2 we are pre-production with no real users. This file lands
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
-- One row per authenticated identity. Populated on first OIDC login from JWT
-- claims (sub, email). Per D8/D13: identity is JWT-only; no env-var override.
--
-- role: 'admin' can issue/revoke tokens for any user, set budgets, view all
--       data; 'developer' can only manage their own tokens and view their own
--       data plus their team's rollup. First user to log in becomes admin
--       (bootstrap rule documented in authentication-STRATEGY.md).
--
-- last_seen_at is updated on each authenticated request, but we do this in
-- batched writes (not on every request) — see api-and-spa-DESIGN.md §12 open
-- question. Column exists; the code that updates it is deferred to phase 0.3.6.

CREATE TYPE user_role AS ENUM ('admin', 'developer');

CREATE TABLE IF NOT EXISTS users (
   id            BIGSERIAL    PRIMARY KEY,
   email         TEXT         NOT NULL UNIQUE,
   name          TEXT,
   role          user_role    NOT NULL DEFAULT 'developer',
   team_id       BIGINT       REFERENCES teams(id) ON DELETE SET NULL,
   created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
   updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
   last_seen_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);

-- =============================================================================
-- api_tokens
-- =============================================================================
-- Per-machine tokens. D9: one developer with three machines (laptop, dev VM,
-- CI runner) gets three tokens, each individually revocable.
--
-- BROWSER SESSIONS DO NOT APPEAR HERE (D14). Browser cookies carry the same
-- JWT format but are stateless — verified by signature alone. Only named,
-- long-lived machine tokens get a row in this table; the row IS the
-- revocation primitive.
--
-- token_hash: SHA-256 of the issued JWT, hex-encoded (64 chars). NOT bcrypt
--   (D14 supersedes the original draft of this comment). Tokens are
--   high-entropy random JWTs (≥ 256 bits); SHA-256 is the right primitive
--   because it's deterministic — the request path can do
--   `WHERE token_hash = $1` for an O(1) lookup. Bcrypt's random salt would
--   force an O(n) bcrypt.compare() per request and break the hot path.
-- expires_at: 90 days from issuance (forced rotation without being painful).
-- revoked_at: soft-delete; rows are kept for audit purposes.
-- last_used_at: for staleness reports / "which tokens haven't been used in 30
--               days, please revoke" admin views. Updated inline per request
--               in v1 (0.3.6); batching is open question §12 in the design doc,
--               revisited when 0.3.7 OTLP ingest produces measurable load.

CREATE TABLE IF NOT EXISTS api_tokens (
   id            BIGSERIAL    PRIMARY KEY,
   user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   label         TEXT         NOT NULL,           -- e.g. "laptop", "dev-vm", "ci"
   token_hash    TEXT         NOT NULL,           -- sha256(jwt) hex; see D14
   expires_at    TIMESTAMPTZ  NOT NULL,
   created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
   last_used_at  TIMESTAMPTZ,
   revoked_at    TIMESTAMPTZ,

   -- A user shouldn't have two active tokens with the same label; once one is
   -- revoked, the label can be reused. Partial unique index handles this.
   CONSTRAINT api_tokens_label_nonempty CHECK (length(label) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_user_label_active
   ON api_tokens(user_id, label)
   WHERE revoked_at IS NULL;

-- Hot-path lookup: every authenticated bearer request does
-- `WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`.
-- Partial unique index keeps the index small (revoked rows aren't kept hot)
-- AND enforces the invariant that no two active tokens share a hash. (D14.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash_active
   ON api_tokens(token_hash)
   WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id     ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at  ON api_tokens(expires_at)
   WHERE revoked_at IS NULL;

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
-- api_tokens uses revoked_at as its mutation, budgets are append-only by
-- effective_from, audit_log is rule-enforced append-only).

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
