/**
 * Unit tests for requireAuth. The token-verification mechanics live in
 * idp.test.ts; here we use a stub `Verifier` and a recording `Db` to
 * exercise the middleware's own logic: bearer extraction, role mapping,
 * the no-role 403, the lazy `users` upsert, and how verifier failures
 * map to status codes.
 */

import express from "express";
import { describe, expect, it } from "vitest";
import type { Db, UpsertUserInput } from "../db.js";
import { AuthError, type VerifiedToken, type Verifier } from "./idp.js";
import { requireAuth } from "./middleware.js";

interface RecordingDb extends Db {
	readonly upserted: UpsertUserInput[];
}

function makeDb(opts: { failUpsert?: boolean } = {}): RecordingDb {
	const upserted: UpsertUserInput[] = [];
	return {
		upserted,
		async upsertUser(input) {
			if (opts.failUpsert) throw new Error("db down");
			upserted.push(input);
		},
		async insertUsageLog() {},
		async fetchUsageTotals() {
			return {
				costUsd: 0,
				estimatedCostUsd: 0,
				turns: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheRead: 0,
				cacheWrite: 0,
			};
		},
		async fetchUsageByDay() {
			return [];
		},
		async fetchUsageByModel() {
			return [];
		},
		async fetchSessions() {
			return [];
		},
		async fetchModelPrices() {
			return { updatedAt: null, items: [] };
		},
		async close() {},
	};
}

// Sentinel token prefixes → the roles claim the stub verifier reports.
const ROLES_BY_PREFIX: ReadonlyArray<readonly [string, readonly string[]]> = [
	["admin", ["TokenTracker.Admin"]],
	["multi", ["TokenTracker.Viewer", "TokenTracker.Admin"]],
	["user", ["TokenTracker.User"]],
	["norole", []],
	["otherrole", ["SomeOtherApp.Reader"]],
];

/** Stub verifier: maps a few sentinel token strings to fixed outcomes. */
function makeVerifier(): Verifier {
	return {
		async verifyAccessToken(token: string): Promise<VerifiedToken> {
			if (token === "throw-unavailable") throw new AuthError("unavailable", "IdP down");
			if (token === "throw-invalid") throw new AuthError("invalid", "bad token");
			if (token === "throw-plain") throw new Error("unexpected");
			const match = ROLES_BY_PREFIX.find(([prefix]) => token.startsWith(prefix));
			return {
				email: "alice@example.invalid",
				name: "Alice",
				oid: "oid-1",
				roles: match ? match[1] : ["TokenTracker.User"],
			};
		},
	};
}

async function withApp<T>(db: Db, fn: (baseUrl: string) => Promise<T>): Promise<T> {
	const app = express();
	app.get("/protected", requireAuth({ verifier: makeVerifier(), db }), (req, res) => {
		res.json({ identity: req.identity });
	});
	const server = app.listen(0);
	try {
		const addr = server.address();
		if (typeof addr !== "object" || addr === null) throw new Error("no address");
		return await fn(`http://127.0.0.1:${addr.port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("requireAuth — happy path", () => {
	it("attaches identity from the verified token and upserts the user", async () => {
		const db = makeDb();
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer user-token" } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { identity: Record<string, unknown> };
			expect(body.identity).toEqual({
				email: "alice@example.invalid",
				name: "Alice",
				oid: "oid-1",
				roles: ["TokenTracker.User"],
				role: "user",
			});
		});
		expect(db.upserted).toEqual([{ email: "alice@example.invalid", name: "Alice", oid: "oid-1" }]);
	});

	it("maps TokenTracker.Admin → admin", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer admin-token" } });
			expect(((await res.json()) as { identity: { role: string } }).identity.role).toBe("admin");
		});
	});

	it("picks the highest-privilege role when several are present", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer multi-token" } });
			expect(((await res.json()) as { identity: { role: string } }).identity.role).toBe("admin");
		});
	});

	it("does not fail the request when the users upsert errors", async () => {
		const db = makeDb({ failUpsert: true });
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer user-token" } });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { identity: { email: string } }).identity.email).toBe("alice@example.invalid");
		});
		expect(db.upserted).toEqual([]);
	});
});

describe("requireAuth — authorization", () => {
	it("403s a token with no app-role claim", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer norole-token" } });
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toMatch(/no role assignment/i);
		});
	});

	it("403s a token whose roles claim has no TokenTracker.* role", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer otherrole-token" } });
			expect(res.status).toBe(403);
		});
	});
});

describe("requireAuth — token presence + verifier failures", () => {
	it("401 'no token' when there is no Authorization header", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`);
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		});
	});

	it("401 'no token' for an empty Bearer", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer " } });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		});
	});

	it("401 'no token' when only a cookie is sent (cookies are not auth anymore)", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { cookie: "session=anything" } });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		});
	});

	it("401 'invalid token' when the verifier rejects it as invalid", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer throw-invalid" } });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("invalid token");
		});
	});

	it("401 'invalid token' on an unexpected (non-AuthError) verifier failure", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer throw-plain" } });
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("invalid token");
		});
	});

	it("503 when the IdP is unreachable", async () => {
		await withApp(makeDb(), async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, { headers: { authorization: "Bearer throw-unavailable" } });
			expect(res.status).toBe(503);
		});
	});
});
