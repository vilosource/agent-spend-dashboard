/**
 * Row-scoping SQL helper. The API enforces authorization in the SQL
 * `WHERE` clause, derived from the authenticated identity (its `role`,
 * mapped from the token's `roles` claim — see middleware.ts). Every
 * endpoint that queries the usage table AND-s the result of this
 * function into its WHERE — tests assert the right scope fires per role.
 *
 * Internal roles: admin / user / viewer (from `TokenTracker.Admin`,
 * `.User`, `.Viewer`). At the row level v1 only distinguishes admin
 * (unrestricted) from everyone else (own rows only); the user/viewer
 * split will matter once there are write endpoints, which there aren't
 * yet.
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
	// user / viewer (or anything else, defensively) — own rows only.
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
