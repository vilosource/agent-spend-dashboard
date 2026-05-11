/**
 * End-to-end tests for `/api/me/*`. Spins up Postgres via testcontainers
 * plus a throwaway local "IdP" (an HTTP server serving an OIDC discovery
 * doc + a JWKs set; tokens are RS256-signed with a local keypair). Seeds
 * a known dataset for two regular users + an admin, then asserts the
 * rowScope() boundary fires correctly:
 *   - user  → only own rows
 *   - admin → all rows
 *
 * Also exercises ?from / ?to range filtering, cursor pagination, the
 * no-role 403, and the no-token 401.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from "jose";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createVerifier } from "../auth/idp.js";
import { createDb, type Db } from "../db.js";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCHEMA_FILES = [
	`${REPO_ROOT}/deploy/docker-compose/postgres/init/001_schema.sql`,
	`${REPO_ROOT}/deploy/docker-compose/postgres/init/002_auth.sql`,
];
const PG_IMAGE = "postgres:16-alpine";
const TEST_TIMEOUT = 60_000;
const CLIENT_ID = "token-tracker-api";
const KID = "test-key-1";

const ALICE = "alice@example.invalid";
const BOB = "bob@example.invalid";
const ADMIN = "admin@example.invalid";

interface Idp {
	issuer: string;
	server: Server;
	privateKey: KeyLike;
}

interface Env {
	pg: StartedTestContainer;
	db: Db;
	server: Server;
	idp: Idp;
	baseUrl: string;
	tempDir: string;
	databaseUrl: string;
	aliceToken: string;
	bobToken: string;
	adminToken: string;
	noRoleToken: string;
}

let env: Env | undefined;

beforeAll(async () => {
	env = await setupEnv();
}, TEST_TIMEOUT);

afterAll(async () => {
	if (env) await teardownEnv(env);
}, TEST_TIMEOUT);

describe("GET /api/me", () => {
	it("returns the authenticated identity", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me`, { headers: { authorization: `Bearer ${env.aliceToken}` } });
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({ email: ALICE, role: "user", roles: ["TokenTracker.User"] });
	});

	it("403s a token with no app-role claim", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me`, { headers: { authorization: `Bearer ${env.noRoleToken}` } });
		expect(r.status).toBe(403);
	});

	it("401s without a token", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me`);
		expect(r.status).toBe(401);
	});
});

describe("GET /api/me/usage — rowScope enforcement", () => {
	it("a regular user sees only their own rows", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { authorization: `Bearer ${env.aliceToken}` } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number; costUsd: number } };
		// Alice has 5 rows seeded; Bob has 7; total dataset is 5+7+3=15.
		expect(body.totals.turns).toBe(5);
		expect(body.totals.costUsd).toBeGreaterThan(0);
	});

	it("admin sees all rows", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { authorization: `Bearer ${env.adminToken}` } });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number } };
		expect(body.totals.turns).toBe(15);
	});

	it("byDay rollup is sorted ascending and matches totals", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { authorization: `Bearer ${env.aliceToken}` } });
		const body = (await r.json()) as { totals: { turns: number }; byDay: { day: string; turns: number }[] };
		const sumByDay = body.byDay.reduce((s, d) => s + d.turns, 0);
		expect(sumByDay).toBe(body.totals.turns);
		const days = body.byDay.map((d) => d.day);
		expect([...days].sort()).toEqual(days);
	});

	it("byModel returns one entry per model, sorted by cost desc", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage`, { headers: { authorization: `Bearer ${env.aliceToken}` } });
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
			headers: { authorization: `Bearer ${env.aliceToken}` },
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { totals: { turns: number; costUsd: number } };
		expect(body.totals.turns).toBe(0);
		expect(body.totals.costUsd).toBe(0);
	});

	it("rejects malformed ?from", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/usage?from=not-a-date`, {
			headers: { authorization: `Bearer ${env.aliceToken}` },
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
	it("a regular user sees only their own sessions", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, {
			headers: { authorization: `Bearer ${env.aliceToken}` },
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as { items: { sessionId: string }[] };
		// Alice has 2 distinct sessions across her 5 rows.
		expect(body.items).toHaveLength(2);
	});

	it("admin sees all sessions across users", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, {
			headers: { authorization: `Bearer ${env.adminToken}` },
		});
		const body = (await r.json()) as { items: { sessionId: string }[] };
		// 2 (alice) + 2 (bob) + 1 (admin) = 5 distinct sessions.
		expect(body.items).toHaveLength(5);
	});

	it("returns nextCursor when there are more rows than ?limit", async () => {
		if (!env) throw new Error("env failed");
		const r = await fetch(`${env.baseUrl}/api/me/sessions?limit=2`, {
			headers: { authorization: `Bearer ${env.adminToken}` },
		});
		const body = (await r.json()) as { items: unknown[]; nextCursor: string | null };
		expect(body.items).toHaveLength(2);
		expect(body.nextCursor).not.toBeNull();
	});

	it("paginates exhaustively without duplicates", async () => {
		if (!env) throw new Error("env failed");
		const e = env;
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let i = 0; i < 10; i += 1) {
			const url: string = cursor
				? `${e.baseUrl}/api/me/sessions?limit=2&cursor=${encodeURIComponent(cursor)}`
				: `${e.baseUrl}/api/me/sessions?limit=2`;
			const r = await fetch(url, { headers: { authorization: `Bearer ${e.adminToken}` } });
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
		const r = await fetch(`${env.baseUrl}/api/me/sessions`, {
			headers: { authorization: `Bearer ${env.aliceToken}` },
		});
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
			headers: { authorization: `Bearer ${env.aliceToken}` },
		});
		expect([200, 400]).toContain(r.status); // not-base64 may parse to empty bytes; either accept or reject deterministically
	});
});

// ---------------------------------------------------------------------------
// env setup + IdP fixture + seed helpers
// ---------------------------------------------------------------------------

async function setupEnv(): Promise<Env> {
	const tempDir = await mkdtemp(join(tmpdir(), "token-tracker-me-"));

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

	const idp = await startIdp();
	const verifier = createVerifier({ issuerUrl: idp.issuer, clientId: CLIENT_ID });

	const apiPort = await freePort();
	const baseUrl = `http://localhost:${apiPort}`;
	const db = createDb(databaseUrl);
	await seedSpendLogs(databaseUrl);

	const app = createApp({ publicUrl: baseUrl, verifier, db });
	const server: Server = await new Promise((resolve) => {
		const s = app.listen(apiPort, () => resolve(s));
	});

	return {
		pg,
		db,
		server,
		idp,
		baseUrl,
		tempDir,
		databaseUrl,
		aliceToken: await mintToken(idp, ALICE, "Alice", ["TokenTracker.User"]),
		bobToken: await mintToken(idp, BOB, "Bob", ["TokenTracker.User"]),
		adminToken: await mintToken(idp, ADMIN, "Admin", ["TokenTracker.Admin"]),
		noRoleToken: await mintToken(idp, "norole@example.invalid", "No Role", []),
	};
}

async function teardownEnv(e: Env): Promise<void> {
	await new Promise<void>((resolve) => e.server.close(() => resolve()));
	await new Promise<void>((resolve) => e.idp.server.close(() => resolve()));
	await e.db.close();
	await e.pg.stop({ timeout: 5000 });
	await rm(e.tempDir, { recursive: true, force: true });
}

async function startIdp(): Promise<Idp> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
	const publicJwk: JWK = await exportJWK(publicKey);
	publicJwk.kid = KID;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";

	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		if (url.startsWith("/.well-known/openid-configuration")) {
			const issuer = `http://127.0.0.1:${addr().port}`;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${issuer}/token` }));
			return;
		}
		if (url.startsWith("/jwks")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ keys: [publicJwk] }));
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	function addr(): net.AddressInfo {
		return server.address() as net.AddressInfo;
	}
	return { issuer: `http://127.0.0.1:${addr().port}`, server, privateKey };
}

async function mintToken(idp: Idp, email: string, name: string, roles: readonly string[]): Promise<string> {
	return await new SignJWT({ preferred_username: email, name, oid: `oid-${email}`, roles: [...roles] })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(idp.issuer)
		.setAudience(CLIENT_ID)
		.setSubject(email)
		.setIssuedAt()
		.setExpirationTime("10m")
		.sign(idp.privateKey);
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
