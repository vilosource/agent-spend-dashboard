/**
 * Row-scoping SQL helper. Per design §4.2 the API enforces
 * authorization in the SQL `WHERE` clause, derived from the
 * authenticated identity. Every endpoint that queries
 * `agent_spend_logs` AND-s the result of this function into its
 * WHERE — tests assert the right scope fires for each role.
 *
 * v1 roles in schema: admin, developer (see init/002_auth.sql).
 * The design also names `team_lead` (own + own team), but the schema
 * doesn't carry that role yet; it's deferred until the role enum and
 * the team-membership lookup land together. For now the helper
 * collapses to: admin → unrestricted, developer → own rows only.
 */

import type { Identity } from "./middleware.js";

export interface RowScope {
	/** SQL fragment to AND into the WHERE clause. Always non-empty. */
	readonly sql: string;
	/** Bind params, in $1, $2, ... order. */
	readonly params: readonly unknown[];
}

export function rowScope(identity: Identity): RowScope {
	if (identity.role === "admin") {
		return { sql: "TRUE", params: [] };
	}
	// developer (or anything else, defensively) — own rows only.
	return { sql: "user_id = $1", params: [identity.email] };
}

/**
 * Compose the rowScope clause with additional WHERE predicates,
 * shifting bind-param numbers correctly. Returns the merged SQL +
 * the merged params, which a query can drop in directly.
 *
 *   const scope = rowScope(identity);
 *   const where = mergeWhere(scope, "ts BETWEEN $1 AND $2", [from, to]);
 *   // where.sql:    "user_id = $1 AND ts BETWEEN $2 AND $3"
 *   // where.params: [email, from, to]
 */
export function mergeWhere(
	scope: RowScope,
	additional: string,
	additionalParams: readonly unknown[],
): { sql: string; params: readonly unknown[] } {
	const offset = scope.params.length;
	const shifted = additional.replace(/\$(\d+)/g, (_, n) => `$${Number.parseInt(n, 10) + offset}`);
	return {
		sql: `${scope.sql} AND ${shifted}`,
		params: [...scope.params, ...additionalParams],
	};
}
