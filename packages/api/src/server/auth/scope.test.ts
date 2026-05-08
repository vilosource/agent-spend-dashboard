import { describe, expect, it } from "vitest";
import type { Identity } from "./middleware.js";
import { mergeWhere, rowScope } from "./scope.js";

const developer: Identity = {
	userId: 1,
	email: "alice@example.invalid",
	name: "Alice",
	role: "developer",
	tokenLabel: "browser",
	source: "cookie",
};

const admin: Identity = {
	userId: 2,
	email: "admin@example.invalid",
	name: "Admin",
	role: "admin",
	tokenLabel: "browser",
	source: "cookie",
};

describe("rowScope", () => {
	it("admin → TRUE / no params", () => {
		expect(rowScope(admin)).toEqual({ sql: "TRUE", params: [] });
	});

	it("developer → user_id = $1 / [email]", () => {
		expect(rowScope(developer)).toEqual({ sql: "user_id = $1", params: ["alice@example.invalid"] });
	});

	it("unknown role falls back to developer (defensive)", () => {
		const weird = { ...developer, role: "guest" as unknown as "developer" };
		expect(rowScope(weird)).toEqual({ sql: "user_id = $1", params: ["alice@example.invalid"] });
	});
});

describe("mergeWhere", () => {
	it("shifts bind-param numbers past the scope params", () => {
		const scope = rowScope(developer);
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
		const scope = rowScope(developer);
		const merged = mergeWhere(scope, "$1 AND $2 AND $10 AND $11", [1, 2, "...", 10, 11]);
		// $1 → $2, $2 → $3, $10 → $11, $11 → $12
		expect(merged.sql).toBe("user_id = $1 AND $2 AND $3 AND $11 AND $12");
		expect(merged.params).toEqual(["alice@example.invalid", 1, 2, "...", 10, 11]);
	});
});
