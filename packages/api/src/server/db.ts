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
	/** Find a user's numeric id by email. Used by 0.3.10's token issuance. */
	findUserIdByEmail(email: string): Promise<number | null>;
	/** Batch INSERT into agent_spend_logs. No-op for an empty array. */
	insertSpendLogs(rows: readonly SpendLogRow[]): Promise<void>;
	close(): Promise<void>;
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
