/**
 * Unit tests for requireAuth — exercise both transports against a fake
 * Db. The integration test (oidc.integration.test.ts) covers the bearer
 * path against real Postgres + a real api_tokens row; this file
 * exercises the branches that are awkward with real infrastructure
 * (revoked, expired, bad signature, missing claims, unsigned token).
 */

import express from "express";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { ActiveTokenRow, Db, InsertApiTokenInput, UserRole, UserRow } from "../db.js";
import { requireAuth } from "./middleware.js";
import { sha256Hex } from "./tokens.js";

const SECRET = "test-secret";

interface FakeDb extends Db {
	tokens: Map<string, ActiveTokenRow>;
	usedIds: number[];
}

function makeFakeDb(): FakeDb {
	const tokens = new Map<string, ActiveTokenRow>();
	const usedIds: number[] = [];
	const db: FakeDb = {
		tokens,
		usedIds,
		async countUsers() {
			return 0;
		},
		async findUserByEmail() {
			return null;
		},
		async findUserIdByEmail() {
			return null;
		},
		async insertUser(_: { email: string; name: string | null; role: UserRole }): Promise<UserRow> {
			throw new Error("not used");
		},
		async findActiveTokenByHash(hash) {
			return tokens.get(hash) ?? null;
		},
		async markTokenUsed(id) {
			usedIds.push(id);
		},
		async insertApiToken(_input: InsertApiTokenInput) {
			return { id: 0 };
		},
		async revokeApiToken() {},
		async close() {},
	};
	return db;
}

async function mintJwt(opts: {
	email: string;
	role: UserRole;
	name?: string | null;
	expSeconds?: number;
}): Promise<string> {
	const secret = new TextEncoder().encode(SECRET);
	const builder = new SignJWT({
		email: opts.email,
		name: opts.name ?? null,
		role: opts.role,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(opts.email)
		.setIssuedAt()
		.setExpirationTime(`${opts.expSeconds ?? 60}s`);
	return await builder.sign(secret);
}

async function withApp<T>(db: Db, fn: (baseUrl: string) => Promise<T>): Promise<T> {
	const app = express();
	app.get("/protected", requireAuth({ db, jwtSecret: SECRET }), (req, res) => {
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

describe("requireAuth — cookie path", () => {
	it("attaches identity from JWT claims and skips DB lookup", async () => {
		const db = makeFakeDb();
		const jwt = await mintJwt({ email: "alice@example.invalid", name: "Alice", role: "admin" });
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { cookie: `agent_spend_session=${jwt}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { identity: Record<string, unknown> };
			expect(body.identity).toEqual({
				userId: null,
				email: "alice@example.invalid",
				name: "Alice",
				role: "admin",
				tokenLabel: "browser",
				source: "cookie",
			});
		});
		expect(db.usedIds, "cookie path must NOT touch markTokenUsed").toEqual([]);
	});

	it("returns 401 with 'invalid token' when the JWT signature is wrong", async () => {
		const db = makeFakeDb();
		const otherSecret = new TextEncoder().encode("other-secret");
		const jwt = await new SignJWT({ email: "x@example.invalid", role: "developer" })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject("x@example.invalid")
			.setIssuedAt()
			.setExpirationTime("60s")
			.sign(otherSecret);
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { cookie: `agent_spend_session=${jwt}` },
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("invalid token");
		});
	});

	it("returns 401 with 'invalid token' for an expired JWT", async () => {
		const db = makeFakeDb();
		const secret = new TextEncoder().encode(SECRET);
		const jwt = await new SignJWT({ email: "x@example.invalid", role: "developer" })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject("x")
			.setIssuedAt(Math.floor(Date.now() / 1000) - 600)
			.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
			.sign(secret);
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { cookie: `agent_spend_session=${jwt}` },
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("invalid token");
		});
	});

	it("returns 401 with 'invalid token claims' when role is missing or wrong", async () => {
		const db = makeFakeDb();
		const secret = new TextEncoder().encode(SECRET);
		const jwt = await new SignJWT({ email: "x@example.invalid", role: "owner" })
			.setProtectedHeader({ alg: "HS256" })
			.setSubject("x")
			.setIssuedAt()
			.setExpirationTime("60s")
			.sign(secret);
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { cookie: `agent_spend_session=${jwt}` },
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("invalid token claims");
		});
	});
});

describe("requireAuth — bearer path", () => {
	it("looks up api_tokens by SHA-256 and attaches identity from the row", async () => {
		const db = makeFakeDb();
		const jwt = await mintJwt({ email: "alice@example.invalid", name: "Alice", role: "developer" });
		const hash = sha256Hex(jwt);
		db.tokens.set(hash, {
			tokenId: 42,
			userId: 7,
			label: "alice-laptop",
			email: "alice@example.invalid",
			role: "admin", // role in DB can override claims (admin promoted alice after issuance)
		});
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { authorization: `Bearer ${jwt}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { identity: Record<string, unknown> };
			expect(body.identity).toEqual({
				userId: 7,
				email: "alice@example.invalid",
				name: "Alice",
				role: "admin", // from DB, not from claims
				tokenLabel: "alice-laptop",
				source: "bearer",
			});
		});
		// markTokenUsed is fire-and-forget; allow microtask + flush.
		await new Promise((r) => setImmediate(r));
		expect(db.usedIds).toEqual([42]);
	});

	it("returns 401 with 'revoked or expired' when no row matches", async () => {
		const db = makeFakeDb();
		const jwt = await mintJwt({ email: "x@example.invalid", role: "developer" });
		// No db.tokens entry — simulates either revoked, expired, or never-issued.
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { authorization: `Bearer ${jwt}` },
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("revoked or expired");
		});
	});

	it("prefers Authorization header over cookie when both are present", async () => {
		const db = makeFakeDb();
		const cookieJwt = await mintJwt({ email: "cookie@example.invalid", role: "developer" });
		const bearerJwt = await mintJwt({ email: "bearer@example.invalid", role: "admin" });
		db.tokens.set(sha256Hex(bearerJwt), {
			tokenId: 1,
			userId: 1,
			label: "ci",
			email: "bearer@example.invalid",
			role: "admin",
		});
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: {
					authorization: `Bearer ${bearerJwt}`,
					cookie: `agent_spend_session=${cookieJwt}`,
				},
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { identity: { source: string; email: string } };
			expect(body.identity.source).toBe("bearer");
			expect(body.identity.email).toBe("bearer@example.invalid");
		});
	});
});

describe("requireAuth — no token", () => {
	it("returns 401 with 'no token' when neither cookie nor bearer is present", async () => {
		const db = makeFakeDb();
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`);
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		});
	});

	it("ignores empty Bearer", async () => {
		const db = makeFakeDb();
		await withApp(db, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/protected`, {
				headers: { authorization: "Bearer " },
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		});
	});
});
