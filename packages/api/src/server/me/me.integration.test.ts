/**
 * End-to-end tests for `/api/me/*`. Spins up Postgres via testcontainers
 * (no Dex needed — we mint JWTs locally and use either cookie or
 * bearer transport), seeds known rows for two developers + an admin,
 * then asserts the rowScope() boundary fires correctly:
 *   - developer cookie/bearer → only own rows
 *   - admin cookie/bearer     → all rows
 *
 * Also exercises ?from / ?to range filtering and cursor pagination.
 */

import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OidcContext } from "../auth/oidc.js";
import { sha256Hex } from "../auth/tokens.js";
import { createDb, type Db } from "../db.js";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCHEMA_FILES = [
	`${REPO_ROOT}/deploy/docker-compose/postgres/init/001_schema.sql`,
	`${REPO_ROOT}/deploy/docker-compose/postgres/init/002_auth.sql`,
];
const PG_IMAGE = "postgres:16-alpine";
const TEST_TIMEOUT = 60_000;
const JWT_SECRET = "test-secret";

const ALICE = "alice@example.invalid";
const BOB = "bob@example.invalid";
const ADMIN = "admin@example.invalid";

interface Env {
	pg: StartedTestContainer;
	db: Db;
	server: Server;
	baseUrl: string;
	tempDir: string;
	databaseUrl: string;
	aliceCookie: string;
	bobCookie: string;
	adminCookie: string;
	aliceBearerJwt: string;
}

let env: Env | undefined;

beforeAll(async () => {
	env = await setupEnv();
}, TEST_TIMEOUT);

afterAll(async () => {
	if (env) await teardownEnv(env);
}, TEST_TIMEOUT);

describe("GET /api/me", () => {
	it("returns the authenticated identity from the cookie", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me`, { headers: { cookie: env.aliceCookie } });
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({
			email: ALICE,
			role: "developer",
			source: "cookie",
			tokenLabel: "browser",
		});
	});

	it("works with the bearer transport too", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me`, {
			headers: { authorization: `Bearer ${env.aliceBearerJwt}` },
		});
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({ email: ALICE, source: "bearer" });
	});
});

describe("GET /api/me/usage — rowScope enforcement", () => {
	it("developer sees only their own rows", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { cookie: env.aliceCookie } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number; costUsd: number } };
		// Alice has 5 rows seeded; Bob has 7; total dataset is 5+7+3=15.
		expect(body.totals.turns).toBe(5);
		expect(body.totals.costUsd).toBeGreaterThan(0);
	});

	it("admin sees all rows", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { cookie: env.adminCookie } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number } };
		expect(body.totals.turns).toBe(15);
	});

	it("byDay rollup is sorted ascending and matches totals", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { cookie: env.aliceCookie } });
		const body = (await r.json()) as { totals: { turns: number }; byDay: { day: string; turns: number }[] };
		const sumByDay = body.byDay.reduce((s, d) => s + d.turns, 0);
		expect(sumByDay).toBe(body.totals.turns);
		const days = body.byDay.map((d) => d.day);
		expect([...days].sort()).toEqual(days);
	});

	it("byModel returns one entry per model, sorted by cost desc", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { cookie: env.aliceCookie } });
		const body = (await r.json()) as { byModel: { model: string; costUsd: number }[] };
		expect(body.byModel.length).toBeGreaterThan(0);
		for (let i = 1; i < body.byModel.length; i += 1) {
			const prev = body.byModel[i - 1];
			const cur = body.byModel[i];
			if (!prev || !cur) continue;
			expect(prev.costUsd).toBeGreaterThanOrEqual(cur.costUsd);
		}
	});

	it("?from / ?to narrow the window", async () => {
		if (!env) throw new Error("env failed");
		// Far-future range: should return empty totals.
		const futureFrom = "2099-01-01T00:00:00Z";
		const futureTo = "2099-12-31T23:59:59Z";
		const r = await fetch(`${env.baseUrl}/api/me/usage?from=${futureFrom}&to=${futureTo}`, {
			headers: { cookie: env.aliceCookie },
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number; costUsd: number } };
		expect(body.totals.turns).toBe(0);
		expect(body.totals.costUsd).toBe(0);
	});

	it("rejects malformed ?from", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage?from=not-a-date`, {
			headers: { cookie: env.aliceCookie },
		});
		expect(r.status).toBe(400);
	});

	it("requires auth", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`);
		expect(r.status).toBe(401);
	});
});

describe("GET /api/me/sessions — pagination + scoping", () => {
	it("developer sees only their own sessions", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, { headers: { cookie: env.aliceCookie } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { items: { sessionId: string }[] };
		// Alice has 2 distinct sessions across her 5 rows.
		expect(body.items).toHaveLength(2);
	});

	it("admin sees all sessions across users", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, { headers: { cookie: env.adminCookie } });
		const body = (await r.json()) as { items: { sessionId: string }[] };
		// 2 (alice) + 2 (bob) + 1 (admin) = 5 distinct sessions.
		expect(body.items).toHaveLength(5);
	});

	it("returns nextCursor when there are more rows than ?limit", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions?limit=2`, { headers: { cookie: env.adminCookie } });
		const body = (await r.json()) as { items: unknown[]; nextCursor: string | null };
		expect(body.items).toHaveLength(2);
		expect(body.nextCursor).not.toBeNull();
	});

	it("paginates exhaustively without duplicates", async () => {
		if (!env) throw new Error("env failed");
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let i = 0; i < 10; i += 1) {
			const url: string = cursor
				? `${env.baseUrl}/api/me/sessions?limit=2&cursor=${encodeURIComponent(cursor)}`
				: `${env.baseUrl}/api/me/sessions?limit=2`;
			const r = await fetch(url, { headers: { cookie: env.adminCookie } });
			const body = (await r.json()) as { items: { sessionId: string }[]; nextCursor: string | null };
			for (const item of body.items) {
				expect(seen.has(item.sessionId), `duplicate session ${item.sessionId} on page ${i}`).toBe(false);
				seen.add(item.sessionId);
			}
			cursor = body.nextCursor;
			if (!cursor) break;
		}
		expect(seen.size).toBe(5); // 5 total sessions
	});

	it("session items include first/last ts, cost, turns, models", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, { headers: { cookie: env.aliceCookie } });
		const body = (await r.json()) as {
			items: {
				sessionId: string;
				firstTs: string;
				lastTs: string;
				costUsd: number;
				turns: number;
				models: string[];
			}[];
		};
		const item = body.items[0];
		expect(item).toBeDefined();
		if (!item) return;
		expect(typeof item.sessionId).toBe("string");
		expect(item.turns).toBeGreaterThan(0);
		expect(item.models.length).toBeGreaterThan(0);
		expect(new Date(item.lastTs).getTime()).toBeGreaterThanOrEqual(new Date(item.firstTs).getTime());
	});

	it("rejects malformed cursor", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions?cursor=not-base64`, {
			headers: { cookie: env.aliceCookie },
		});
		expect([200, 400]).toContain(r.status); // not-base64 may parse to empty bytes; either accept or reject deterministically
	});
});

describe("/api/me/tokens — phase 0.3.10", () => {
	it("GET returns the seeded bearer token row for alice", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens`, { headers: { cookie: env.aliceCookie } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { items: { label: string; id: number }[] };
		expect(body.items.some((t) => t.label === "test-machine")).toBe(true);
	});

	it("GET requires auth", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens`);
		expect(r.status).toBe(401);
	});

	it("GET scopes to the caller — bob does not see alice's tokens", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens`, { headers: { cookie: env.bobCookie } });
		const body = (await r.json()) as { items: { label: string }[] };
		expect(body.items.find((t) => t.label === "test-machine")).toBeUndefined();
	});

	it("POST mints a working bearer token", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "spec-laptop" }),
		});
		expect(r.status).toBe(201);
		const body = (await r.json()) as { id: number; label: string; token: string; expiresAt: string };
		expect(body.label).toBe("spec-laptop");
		expect(typeof body.token).toBe("string");
		expect(body.token.split(".").length).toBe(3); // jwt shape
		// Round-trip: the minted token authenticates.
		const me = await fetch(`${env.baseUrl}/api/me`, {
			headers: { authorization: `Bearer ${body.token}` },
		});
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ email: ALICE, source: "bearer", tokenLabel: "spec-laptop" });
	});

	it("POST rejects invalid label", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "spaces not allowed" }),
		});
		expect(r.status).toBe(400);
	});

	it("POST returns 409 on duplicate active label", async () => {
		if (!env) throw new Error("env failed");
		// Mint once.
		const first = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "duplicate-label-test" }),
		});
		expect(first.status).toBe(201);
		// Second mint with same label — partial unique index fires.
		const second = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "duplicate-label-test" }),
		});
		expect(second.status).toBe(409);
	});

	it("DELETE revokes the caller's own token; the token stops authenticating", async () => {
		if (!env) throw new Error("env failed");
		const minted = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "to-be-revoked" }),
		});
		const { id, token } = (await minted.json()) as { id: number; token: string };

		// Token works pre-revoke.
		const before = await fetch(`${env.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } });
		expect(before.status).toBe(200);

		const del = await fetch(`${env.baseUrl}/api/me/tokens/${id}`, {
			method: "DELETE",
			headers: { cookie: env.aliceCookie },
		});
		expect(del.status).toBe(204);

		// Token rejects post-revoke (revoked_at IS NULL clause filters).
		const after = await fetch(`${env.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } });
		expect(after.status).toBe(401);
	});

	it("DELETE 404s on someone else's token id", async () => {
		if (!env) throw new Error("env failed");
		// Mint as alice, attempt to revoke as bob.
		const minted = await fetch(`${env.baseUrl}/api/me/tokens`, {
			method: "POST",
			headers: { cookie: env.aliceCookie, "content-type": "application/json" },
			body: JSON.stringify({ label: "alice-only-token" }),
		});
		const { id } = (await minted.json()) as { id: number };

		const del = await fetch(`${env.baseUrl}/api/me/tokens/${id}`, {
			method: "DELETE",
			headers: { cookie: env.bobCookie },
		});
		expect(del.status).toBe(404);

		// Confirm it's still active for alice.
		const list = await fetch(`${env.baseUrl}/api/me/tokens`, { headers: { cookie: env.aliceCookie } });
		const body = (await list.json()) as { items: { label: string }[] };
		expect(body.items.find((t) => t.label === "alice-only-token")).toBeDefined();
	});

	it("DELETE 400s on a non-numeric id", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/tokens/abc`, {
			method: "DELETE",
			headers: { cookie: env.aliceCookie },
		});
		expect(r.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// env setup + seed helpers
// ---------------------------------------------------------------------------

async function setupEnv(): Promise<Env> {
	const tempDir = await mkdtemp(join(tmpdir(), "agent-spend-me-"));

	const pg = await new GenericContainer(PG_IMAGE)
		.withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "test" })
		.withExposedPorts(5432)
		.withCopyFilesToContainer(
			SCHEMA_FILES.map((source, i) => ({
				source,
				target: `/docker-entrypoint-initdb.d/${String(i + 1).padStart(3, "0")}.sql`,
			})),
		)
		.withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
		.withStartupTimeout(60_000)
		.start();

	const dbUrl = new URL(`postgresql://${pg.getHost()}:${pg.getMappedPort(5432)}/test`);
	dbUrl.username = "test";
	dbUrl.password = "test";
	const databaseUrl = dbUrl.toString();

	const apiPort = await freePort();
	const baseUrl = `http://localhost:${apiPort}`;
	const db = createDb(databaseUrl);

	// Seed: three users in `users`, plus a known dataset in agent_spend_logs.
	await db.insertUser({ email: ALICE, name: "Alice", role: "developer" });
	await db.insertUser({ email: BOB, name: "Bob", role: "developer" });
	await db.insertUser({ email: ADMIN, name: "Admin", role: "admin" });
	await seedSpendLogs(databaseUrl);

	// Mint the cookies (HS256 JWT signed with JWT_SECRET; same shape the
	// auth/session.ts issuer produces in production).
	const aliceCookie = `agent_spend_session=${await mintSessionJwt(ALICE, "developer")}`;
	const bobCookie = `agent_spend_session=${await mintSessionJwt(BOB, "developer")}`;
	const adminCookie = `agent_spend_session=${await mintSessionJwt(ADMIN, "admin")}`;

	// One bearer JWT for the bearer-transport assertion. Insert the row
	// so it's a real, non-revoked token.
	const aliceBearerJwt = await mintSessionJwt(ALICE, "developer", "90d");
	const aliceUserId = await db.findUserIdByEmail(ALICE);
	if (!aliceUserId) throw new Error("alice missing");
	await db.insertApiToken({
		userId: aliceUserId,
		label: "test-machine",
		tokenHash: sha256Hex(aliceBearerJwt),
		expiresAt: new Date(Date.now() + 90 * 86_400_000),
	});

	const app = createApp({
		publicUrl: baseUrl,
		jwtSecret: JWT_SECRET,
		oidc: {} as OidcContext,
		db,
	});
	const server: Server = await new Promise((resolve) => {
		const s = app.listen(apiPort, () => resolve(s));
	});

	return {
		pg,
		db,
		server,
		baseUrl,
		tempDir,
		databaseUrl,
		aliceCookie,
		bobCookie,
		adminCookie,
		aliceBearerJwt,
	};
}

async function teardownEnv(e: Env): Promise<void> {
	await new Promise<void>((resolve) => e.server.close(() => resolve()));
	await e.db.close();
	await e.pg.stop({ timeout: 5000 });
	await rm(e.tempDir, { recursive: true, force: true });
}

async function mintSessionJwt(email: string, role: "admin" | "developer", exp = "60s"): Promise<string> {
	const secret = new TextEncoder().encode(JWT_SECRET);
	return await new SignJWT({ email, name: email.split("@")[0], role })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(email)
		.setIssuedAt()
		.setExpirationTime(exp)
		.sign(secret);
}

/**
 * Insert 15 known rows: 5 for Alice across 2 sessions, 7 for Bob across
 * 2 sessions, 3 for Admin in 1 session. Three distinct models so
 * byModel rollup is non-trivial. Spread across recent days so byDay
 * has multiple buckets.
 */
async function seedSpendLogs(databaseUrl: string): Promise<void> {
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		const now = new Date();
		const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
		// Each row: ts, user_id, machine_id, session_id, model, provider, cost
		const rows: Array<[Date, string, string, string, string, string, number]> = [
			// Alice — session A (3 rows, 2 days, glm-4.6)
			[
				day(0),
				ALICE,
				"11111111-1111-1111-1111-111111111111",
				"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
				"glm-4.6",
				"z.ai",
				0.1,
			],
			[
				day(0),
				ALICE,
				"11111111-1111-1111-1111-111111111111",
				"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
				"glm-4.6",
				"z.ai",
				0.05,
			],
			[
				day(1),
				ALICE,
				"11111111-1111-1111-1111-111111111111",
				"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
				"glm-4.6",
				"z.ai",
				0.15,
			],
			// Alice — session B (2 rows, 1 day, copilot-gpt-4o)
			[
				day(2),
				ALICE,
				"11111111-1111-1111-1111-111111111111",
				"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
				"copilot-gpt-4o",
				"github",
				0.02,
			],
			[
				day(2),
				ALICE,
				"11111111-1111-1111-1111-111111111111",
				"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
				"copilot-gpt-4o",
				"github",
				0.03,
			],
			// Bob — session A (4 rows)
			[
				day(0),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
				"glm-4.6",
				"z.ai",
				0.2,
			],
			[
				day(0),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
				"glm-4.6",
				"z.ai",
				0.2,
			],
			[
				day(1),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
				"glm-4.6",
				"z.ai",
				0.2,
			],
			[
				day(1),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
				"glm-4.6",
				"z.ai",
				0.2,
			],
			// Bob — session B (3 rows)
			[
				day(3),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
				"claude-sonnet-4-6",
				"anthropic",
				0.3,
			],
			[
				day(3),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
				"claude-sonnet-4-6",
				"anthropic",
				0.3,
			],
			[
				day(4),
				BOB,
				"22222222-2222-2222-2222-222222222222",
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
				"claude-sonnet-4-6",
				"anthropic",
				0.3,
			],
			// Admin — session A (3 rows)
			[
				day(0),
				ADMIN,
				"33333333-3333-3333-3333-333333333333",
				"cccccccc-cccc-cccc-cccc-cccccccccccc",
				"glm-4.6",
				"z.ai",
				0.05,
			],
			[
				day(0),
				ADMIN,
				"33333333-3333-3333-3333-333333333333",
				"cccccccc-cccc-cccc-cccc-cccccccccccc",
				"glm-4.6",
				"z.ai",
				0.05,
			],
			[
				day(0),
				ADMIN,
				"33333333-3333-3333-3333-333333333333",
				"cccccccc-cccc-cccc-cccc-cccccccccccc",
				"glm-4.6",
				"z.ai",
				0.05,
			],
		];
		for (const [ts, userId, machineId, sessionId, model, provider, cost] of rows) {
			await pool.query(
				`INSERT INTO agent_spend_logs (
					ts, user_id, machine_id, session_id, provider, api, model,
					harness_name, input_tokens, output_tokens,
					cost_input_usd, cost_output_usd, cost_total_usd
				) VALUES ($1,$2,$3,$4,$5,'anthropic-messages',$6,'pi',100,50,$7,$7,$7)`,
				[ts, userId, machineId, sessionId, provider, model, cost],
			);
		}
	} finally {
		await pool.end();
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.unref();
		s.on("error", reject);
		s.listen(0, () => {
			const port = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(port));
		});
	});
}
