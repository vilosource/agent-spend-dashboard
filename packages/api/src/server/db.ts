/**
 * Postgres connection pool, wrapped behind a thin interface (`Db`) so
 * tests can swap in an in-memory fake without touching `pg`.
 *
 * Phase 0.3.3 added the user ops (count/find/insert) for the OIDC
 * bootstrap. Phase 0.3.6 adds the api_tokens ops the requireAuth
 * middleware (bearer path) needs. Schema: see
 * deploy/docker-compose/postgres/init/002_auth.sql.
 */

import { Pool as PgPool, type Pool } from "pg";
import type { SpendLogRow } from "./ingest/transform.js";

export type UserRole = "admin" | "developer";

export interface UserRow {
	readonly email: string;
	readonly name: string | null;
	readonly role: UserRole;
}

/**
 * Minimal projection of `api_tokens` rows the auth middleware needs.
 * Joined to `users` so we can attach the user's email + role to the
 * request without a second query.
 */
export interface ActiveTokenRow {
	readonly tokenId: number;
	readonly userId: number;
	readonly label: string;
	readonly email: string;
	readonly role: UserRole;
}

export interface InsertApiTokenInput {
	readonly userId: number;
	readonly label: string;
	readonly tokenHash: string;
	readonly expiresAt: Date;
}

/**
 * Listing projection for /api/me/tokens. The token itself is never
 * returned after issuance — only metadata for revocation UX.
 */
export interface TokenListRow {
	readonly id: number;
	readonly label: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly lastUsedAt: Date | null;
}

export interface Db {
	countUsers(): Promise<number>;
	findUserByEmail(email: string): Promise<UserRow | null>;
	insertUser(input: { email: string; name: string | null; role: UserRole }): Promise<UserRow>;
	/**
	 * Look up a non-revoked, non-expired api_tokens row by its SHA-256
	 * hash. Joined to `users` so the caller gets identity in one query.
	 */
	findActiveTokenByHash(tokenHash: string): Promise<ActiveTokenRow | null>;
	/** Inline `last_used_at = now()` per D14; batching deferred to 0.3.7. */
	markTokenUsed(tokenId: number): Promise<void>;
	/** Insert a token row. Used by tests today; by the SPA Install page in 0.3.10. */
	insertApiToken(input: InsertApiTokenInput): Promise<{ id: number }>;
	/** Soft-revoke. Used by tests today; by the SPA Settings → Tokens page in 0.3.10. */
	revokeApiToken(tokenId: number): Promise<void>;
	/**
	 * Soft-revoke restricted to a user's own row — returns true if a row
	 * was updated, false if the (id, user_id) pair didn't match an active
	 * row. Lets `/api/me/tokens/:id` enforce ownership in one query.
	 */
	revokeApiTokenForUser(tokenId: number, userId: number): Promise<boolean>;
	/** List a user's non-revoked, non-expired tokens, newest first. */
	listUserTokens(userId: number): Promise<TokenListRow[]>;
	/** Find a user's numeric id by email. Used by 0.3.10's token issuance. */
	findUserIdByEmail(email: string): Promise<number | null>;
	/** Batch INSERT into agent_spend_logs. No-op for an empty array. */
	insertSpendLogs(rows: readonly SpendLogRow[]): Promise<void>;
	/**
	 * Aggregate totals over agent_spend_logs filtered by `where` (an
	 * AND-able SQL fragment built via auth/scope.ts) and `params`.
	 * Returns the four scalar sums + count the /me KPI cards display.
	 */
	fetchUsageTotals(where: string, params: readonly unknown[]): Promise<UsageTotals>;
	/** Per-day rollup; one row per UTC calendar day in the range, sorted asc. */
	fetchUsageByDay(where: string, params: readonly unknown[]): Promise<UsageByDay[]>;
	/** Per-model rollup; sorted by cost desc. */
	fetchUsageByModel(where: string, params: readonly unknown[]): Promise<UsageByModel[]>;
	/**
	 * Paginated session list. Cursor is `(last_ts, session_id)` per
	 * design §5.2. Caller passes `cursorTs`/`cursorSessionId` decoded
	 * from the opaque `?cursor=` query param (or null for the first page).
	 */
	fetchSessions(input: FetchSessionsInput): Promise<SessionRow[]>;
	close(): Promise<void>;
}

export interface UsageTotals {
	readonly costUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface UsageByDay {
	readonly day: string; // ISO date (YYYY-MM-DD)
	readonly costUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface UsageByModel {
	readonly model: string;
	readonly provider: string;
	readonly costUsd: number;
	readonly turns: number;
}

export interface FetchSessionsInput {
	readonly where: string;
	readonly params: readonly unknown[];
	readonly limit: number;
	/** When set, return rows whose (last_ts, session_id) is strictly less than the cursor. */
	readonly cursorLastTs: Date | null;
	readonly cursorSessionId: string | null;
}

export interface SessionRow {
	readonly sessionId: string;
	readonly firstTs: Date;
	readonly lastTs: Date;
	readonly costUsd: number;
	readonly turns: number;
	readonly models: readonly string[];
}

const SPEND_LOG_COLUMNS = [
	"ts",
	"user_id",
	"team",
	"machine_id",
	"session_id",
	"workspace_cwd",
	"workspace_repo",
	"workspace_branch",
	"workspace_is_ci",
	"provider",
	"api",
	"model",
	"response_model",
	"harness_name",
	"harness_version",
	"input_tokens",
	"output_tokens",
	"cache_read",
	"cache_write",
	"cost_input_usd",
	"cost_output_usd",
	"cost_cache_read_usd",
	"cost_cache_write_usd",
	"cost_total_usd",
	"cost_estimation",
	"stop_reason",
	"event_kind",
	"environment",
] as const;

function spendLogValues(row: SpendLogRow): readonly unknown[] {
	return [
		row.ts,
		row.userId,
		row.team,
		row.machineId,
		row.sessionId,
		row.workspaceCwd,
		row.workspaceRepo,
		row.workspaceBranch,
		row.workspaceIsCi,
		row.provider,
		row.api,
		row.model,
		row.responseModel,
		row.harnessName,
		row.harnessVersion,
		row.inputTokens,
		row.outputTokens,
		row.cacheRead,
		row.cacheWrite,
		row.costInputUsd,
		row.costOutputUsd,
		row.costCacheReadUsd,
		row.costCacheWriteUsd,
		row.costTotalUsd,
		row.costEstimation,
		row.stopReason,
		row.eventKind,
		row.environment,
	];
}

export function createDb(databaseUrl: string): Db {
	const pool: Pool = new PgPool({ connectionString: databaseUrl });
	return {
		async countUsers() {
			const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
			return Number.parseInt(rows[0]?.count ?? "0", 10);
		},

		async findUserByEmail(email: string) {
			const { rows } = await pool.query<{ email: string; name: string | null; role: UserRole }>(
				"SELECT email, name, role FROM users WHERE email = $1",
				[email],
			);
			const row = rows[0];
			return row ? { email: row.email, name: row.name, role: row.role } : null;
		},

		async insertUser({ email, name, role }) {
			const { rows } = await pool.query<{ email: string; name: string | null; role: UserRole }>(
				`INSERT INTO users (email, name, role)
				 VALUES ($1, $2, $3)
				 RETURNING email, name, role`,
				[email, name, role],
			);
			const row = rows[0];
			if (!row) throw new Error("INSERT users RETURNING produced no row");
			return { email: row.email, name: row.name, role: row.role };
		},

		async findUserIdByEmail(email: string) {
			const { rows } = await pool.query<{ id: string }>("SELECT id::text AS id FROM users WHERE email = $1", [
				email,
			]);
			const row = rows[0];
			return row ? Number.parseInt(row.id, 10) : null;
		},

		async findActiveTokenByHash(tokenHash: string) {
			// Partial unique index on api_tokens(token_hash) WHERE revoked_at IS NULL
			// (D14) makes this an index-only seek for the live-token case.
			const { rows } = await pool.query<{
				token_id: string;
				user_id: string;
				label: string;
				email: string;
				role: UserRole;
			}>(
				`SELECT t.id::text   AS token_id,
				        t.user_id::text AS user_id,
				        t.label,
				        u.email,
				        u.role
				   FROM api_tokens t
				   JOIN users u ON u.id = t.user_id
				  WHERE t.token_hash = $1
				    AND t.revoked_at IS NULL
				    AND t.expires_at > now()`,
				[tokenHash],
			);
			const row = rows[0];
			if (!row) return null;
			return {
				tokenId: Number.parseInt(row.token_id, 10),
				userId: Number.parseInt(row.user_id, 10),
				label: row.label,
				email: row.email,
				role: row.role,
			};
		},

		async markTokenUsed(tokenId: number) {
			await pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [tokenId]);
		},

		async insertApiToken({ userId, label, tokenHash, expiresAt }) {
			const { rows } = await pool.query<{ id: string }>(
				`INSERT INTO api_tokens (user_id, label, token_hash, expires_at)
				 VALUES ($1, $2, $3, $4)
				 RETURNING id::text AS id`,
				[userId, label, tokenHash, expiresAt],
			);
			const row = rows[0];
			if (!row) throw new Error("INSERT api_tokens RETURNING produced no row");
			return { id: Number.parseInt(row.id, 10) };
		},

		async revokeApiToken(tokenId: number) {
			await pool.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [tokenId]);
		},

		async revokeApiTokenForUser(tokenId: number, userId: number) {
			const { rowCount } = await pool.query(
				`UPDATE api_tokens SET revoked_at = now()
				  WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
				[tokenId, userId],
			);
			return (rowCount ?? 0) > 0;
		},

		async listUserTokens(userId: number) {
			const { rows } = await pool.query<{
				id: string;
				label: string;
				created_at: Date;
				expires_at: Date;
				last_used_at: Date | null;
			}>(
				`SELECT id::text       AS id,
				        label,
				        created_at,
				        expires_at,
				        last_used_at
				   FROM api_tokens
				  WHERE user_id = $1
				    AND revoked_at IS NULL
				    AND expires_at > now()
				  ORDER BY created_at DESC, id DESC`,
				[userId],
			);
			return rows.map((r) => ({
				id: Number.parseInt(r.id, 10),
				label: r.label,
				createdAt: r.created_at,
				expiresAt: r.expires_at,
				lastUsedAt: r.last_used_at,
			}));
		},

		async fetchUsageTotals(where, params) {
			// NUMERIC casts to text in pg's default mapping; SUM with no
			// rows returns NULL, so we COALESCE to 0 and parse after.
			const { rows: result } = await pool.query<{
				cost_usd: string;
				turns: string;
				input_tokens: string;
				output_tokens: string;
				cache_read: string;
				cache_write: string;
			}>(
				`SELECT COALESCE(SUM(cost_total_usd), 0)::text AS cost_usd,
				        COUNT(*)::text                          AS turns,
				        COALESCE(SUM(input_tokens), 0)::text    AS input_tokens,
				        COALESCE(SUM(output_tokens), 0)::text   AS output_tokens,
				        COALESCE(SUM(cache_read), 0)::text      AS cache_read,
				        COALESCE(SUM(cache_write), 0)::text     AS cache_write
				   FROM agent_spend_logs
				  WHERE ${where}`,
				[...params],
			);
			const r = result[0];
			if (!r) return { costUsd: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
			return {
				costUsd: Number.parseFloat(r.cost_usd),
				turns: Number.parseInt(r.turns, 10),
				inputTokens: Number.parseInt(r.input_tokens, 10),
				outputTokens: Number.parseInt(r.output_tokens, 10),
				cacheRead: Number.parseInt(r.cache_read, 10),
				cacheWrite: Number.parseInt(r.cache_write, 10),
			};
		},

		async fetchUsageByDay(where, params) {
			const { rows: result } = await pool.query<{
				day: string;
				cost_usd: string;
				turns: string;
				input_tokens: string;
				output_tokens: string;
			}>(
				`SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD')      AS day,
				        COALESCE(SUM(cost_total_usd), 0)::text            AS cost_usd,
				        COUNT(*)::text                                    AS turns,
				        COALESCE(SUM(input_tokens), 0)::text              AS input_tokens,
				        COALESCE(SUM(output_tokens), 0)::text             AS output_tokens
				   FROM agent_spend_logs
				  WHERE ${where}
				  GROUP BY 1
				  ORDER BY 1`,
				[...params],
			);
			return result.map((r) => ({
				day: r.day,
				costUsd: Number.parseFloat(r.cost_usd),
				turns: Number.parseInt(r.turns, 10),
				inputTokens: Number.parseInt(r.input_tokens, 10),
				outputTokens: Number.parseInt(r.output_tokens, 10),
			}));
		},

		async fetchUsageByModel(where, params) {
			const { rows: result } = await pool.query<{
				model: string;
				provider: string;
				cost_usd: string;
				turns: string;
			}>(
				`SELECT model,
				        provider,
				        COALESCE(SUM(cost_total_usd), 0)::text AS cost_usd,
				        COUNT(*)::text                         AS turns
				   FROM agent_spend_logs
				  WHERE ${where}
				  GROUP BY model, provider
				  ORDER BY SUM(cost_total_usd) DESC NULLS LAST`,
				[...params],
			);
			return result.map((r) => ({
				model: r.model,
				provider: r.provider,
				costUsd: Number.parseFloat(r.cost_usd),
				turns: Number.parseInt(r.turns, 10),
			}));
		},

		async fetchSessions({ where, params, limit, cursorLastTs, cursorSessionId }) {
			// Build a query that:
			//   - groups agent_spend_logs by session_id under `where`
			//   - keeps only sessions whose (max(ts), session_id) is strictly
			//     less than the cursor when one is provided
			//   - returns up to `limit` rows ordered by (last_ts DESC, session_id DESC)
			//
			// The HAVING clause does the cursor comparison against the
			// per-session aggregate so the row matches the ORDER BY tuple.
			const cursorFragment =
				cursorLastTs && cursorSessionId
					? `HAVING (MAX(ts), session_id::text) < ($${params.length + 1}::timestamptz, $${params.length + 2}::text)`
					: "";
			const cursorParams = cursorLastTs && cursorSessionId ? [cursorLastTs, cursorSessionId] : [];
			const limitPlaceholder = `$${params.length + cursorParams.length + 1}`;

			const sql = `
				SELECT session_id::text                        AS session_id,
				       MIN(ts)                                  AS first_ts,
				       MAX(ts)                                  AS last_ts,
				       COALESCE(SUM(cost_total_usd), 0)::text   AS cost_usd,
				       COUNT(*)::text                           AS turns,
				       array_agg(DISTINCT model)                AS models
				  FROM agent_spend_logs
				 WHERE ${where}
				 GROUP BY session_id
				 ${cursorFragment}
				 ORDER BY MAX(ts) DESC, session_id DESC
				 LIMIT ${limitPlaceholder}
			`;
			const { rows: result } = await pool.query<{
				session_id: string;
				first_ts: Date;
				last_ts: Date;
				cost_usd: string;
				turns: string;
				models: string[];
			}>(sql, [...params, ...cursorParams, limit]);
			return result.map((r) => ({
				sessionId: r.session_id,
				firstTs: r.first_ts,
				lastTs: r.last_ts,
				costUsd: Number.parseFloat(r.cost_usd),
				turns: Number.parseInt(r.turns, 10),
				models: r.models,
			}));
		},

		async insertSpendLogs(rows) {
			if (rows.length === 0) return;
			// Postgres' parameter limit is 65 535 across all rows. With
			// SPEND_LOG_COLUMNS.length columns per row that bounds us at
			// ~2 340 rows per call. Real OTLP batches are much smaller
			// (one extension flushes a handful per turn), so we INSERT in
			// one call. If a future scenario needs bigger batches, chunk
			// by Math.floor(65000 / SPEND_LOG_COLUMNS.length).
			const colCount = SPEND_LOG_COLUMNS.length;
			const placeholders: string[] = [];
			const values: unknown[] = [];
			let p = 1;
			for (const row of rows) {
				const row$: string[] = [];
				for (let i = 0; i < colCount; i += 1) {
					row$.push(`$${p}`);
					p += 1;
				}
				placeholders.push(`(${row$.join(",")})`);
				values.push(...spendLogValues(row));
			}
			const sql = `INSERT INTO agent_spend_logs (${SPEND_LOG_COLUMNS.join(",")}) VALUES ${placeholders.join(",")}`;
			await pool.query(sql, values);
		},

		async close() {
			await pool.end();
		},
	};
}
