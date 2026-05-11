import { describe, expect, it } from "vitest";
import type { Identity } from "./middleware.js";
import { mergeWhere, rowScope } from "./scope.js";

const user: Identity = {
	email: "alice@example.invalid",
	name: "Alice",
	oid: "oid-1",
	roles: ["TokenTracker.User"],
	role: "user",
};

const admin: Identity = {
	email: "admin@example.invalid",
	name: "Admin",
	oid: "oid-2",
	roles: ["TokenTracker.Admin"],
	role: "admin",
};

describe("rowScope", () => {
	it("admin → TRUE / no params", () => {
		expect(rowScope(admin)).toEqual({ sql: "TRUE", params: [] });
	});

	it("user → user_id = $1 / [email]", () => {
		expect(rowScope(user)).toEqual({ sql: "user_id = $1", params: ["alice@example.invalid"] });
	});

	it("viewer → own rows only, same as user", () => {
		const viewer: Identity = { ...user, role: "viewer", roles: ["TokenTracker.Viewer"] };
		expect(rowScope(viewer)).toEqual({ sql: "user_id = $1", params: ["alice@example.invalid"] });
	});

	it("unknown role falls back to own rows (defensive)", () => {
		const weird = { ...user, role: "guest" as unknown as Identity["role"] };
		expect(rowScope(weird)).toEqual({ sql: "user_id = $1", params: ["alice@example.invalid"] });
	});
});

describe("mergeWhere", () => {
	it("shifts bind-param numbers past the scope params", () => {
		const scope = rowScope(user);
		const merged = mergeWhere(scope, "ts BETWEEN $1 AND $2", ["from", "to"]);
		expect(merged.sql).toBe("user_id = $1 AND ts BETWEEN $2 AND $3");
		expect(merged.params).toEqual(["alice@example.invalid", "from", "to"]);
	});

	it("admin scope: no shift needed (TRUE has zero params)", () => {
		const scope = rowScope(admin);
		const merged = mergeWhere(scope, "ts BETWEEN $1 AND $2", ["from", "to"]);
		expect(merged.sql).toBe("TRUE AND ts BETWEEN $1 AND $2");
		expect(merged.params).toEqual(["from", "to"]);
	});

	it("handles multi-digit param numbers correctly", () => {
		const scope = rowScope(user);
		const merged = mergeWhere(scope, "$1 AND $2 AND $10 AND $11", [1, 2, "...", 10, 11]);
		// $1 → $2, $2 → $3, $10 → $11, $11 → $12
		expect(merged.sql).toBe("user_id = $1 AND $2 AND $3 AND $11 AND $12");
		expect(merged.params).toEqual(["alice@example.invalid", 1, 2, "...", 10, 11]);
	});
});
