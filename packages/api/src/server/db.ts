/**
 * Postgres connection pool, wrapped behind a thin interface (`Db`) so
 * tests can swap in an in-memory fake without touching `pg`.
 *
 * Since the auth rewrite the server issues nothing, so there is no
 * `api_tokens` table and no first-user bootstrap. The only thing the
 * auth path writes is a lazy `users` upsert (email/name/oid +
 * last_seen_at) on each authenticated request — bookkeeping, not a
 * foreign-key target. Role is NOT stored; it comes from the token's
 * `roles` claim every request (token-tracker-redesign-DESIGN.md D7).
 *
 * The events table is `usage_log` (renamed from the old `agent_spend_logs`).
 * Schema: see deploy/docker-compose/postgres/init/{001_schema,002_auth}.sql.
 */

import { Pool as PgPool, type Pool } from "pg";
import type { UsageLogRow } from "./ingest/transform.js";

export interface UpsertUserInput {
	readonly email: string;
	readonly name: string | null;
	readonly oid: string | null;
}

export interface Db {
	/**
	 * Lazily record the authenticated user (insert on first sight, refresh
	 * name/oid + bump last_seen_at otherwise). Keyed by email — the usage
	 * rows join on email, so email stays the natural key even though we
	 * also store the IdP `oid` when the token carries one.
	 */
	upsertUser(input: UpsertUserInput): Promise<void>;
	/** Batch INSERT into usage_log. No-op for an empty array. */
	insertUsageLog(rows: readonly UsageLogRow[]): Promise<void>;
	/**
	 * Aggregate totals over usage_log filtered by `where` (an
	 * AND-able SQL fragment built via auth/scope.ts) and `params`.
	 * Returns the four scalar sums + count the /me KPI cards display.
	 */
	fetchUsageTotals(where: string, params: readonly unknown[]): Promise<UsageTotals>;
	/** Per-day rollup; one row per UTC calendar day in the range, sorted asc. */
	fetchUsageByDay(where: string, params: readonly unknown[]): Promise<UsageByDay[]>;
	/** Per-model rollup; sorted by cost desc. */
	fetchUsageByModel(where: string, params: readonly unknown[]): Promise<UsageByModel[]>;
	/**
	 * Paginated session list. Cursor is `(last_ts, session_id)`. Caller
	 * passes `cursorLastTs`/`cursorSessionId` decoded from the opaque
	 * `?cursor=` query param (or null for the first page).
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

const USAGE_LOG_COLUMNS = [
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

function usageLogValues(row: UsageLogRow): readonly unknown[] {
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
		async upsertUser({ email, name, oid }) {
			await pool.query(
				`INSERT INTO users (email, name, oid, last_seen_at)
				 VALUES ($1, $2, $3, now())
				 ON CONFLICT (email) DO UPDATE
				   SET name         = EXCLUDED.name,
				       oid          = COALESCE(EXCLUDED.oid, users.oid),
				       last_seen_at = now()`,
				[email, name, oid],
			);
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
				   FROM usage_log
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
				   FROM usage_log
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
				   FROM usage_log
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
			//   - groups usage_log by session_id under `where`
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
				  FROM usage_log
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

		async insertUsageLog(rows) {
			if (rows.length === 0) return;
			// Postgres' parameter limit is 65 535 across all rows. With
			// USAGE_LOG_COLUMNS.length columns per row that bounds us at
			// ~2 340 rows per call. Real OTLP batches are much smaller
			// (one extension flushes a handful per turn), so we INSERT in
			// one call. If a future scenario needs bigger batches, chunk
			// by Math.floor(65000 / USAGE_LOG_COLUMNS.length).
			const colCount = USAGE_LOG_COLUMNS.length;
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
				values.push(...usageLogValues(row));
			}
			const sql = `INSERT INTO usage_log (${USAGE_LOG_COLUMNS.join(",")}) VALUES ${placeholders.join(",")}`;
			await pool.query(sql, values);
		},

		async close() {
			await pool.end();
		},
	};
}
