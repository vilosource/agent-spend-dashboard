/**
 * End-to-end test for the OTLP `/v1/traces` ingest path. Spins up a
 * real Postgres via testcontainers (with the init/*.sql schema applied),
 * issues a real api_tokens row, sends a real OTLP/JSON payload via the
 * Express app, and asserts the rows that landed in agent_spend_logs.
 *
 * Dex is not needed here — `/v1/traces` is bearer-only, and the bearer
 * is whatever JWT we mint + insert into api_tokens. That keeps this
 * test fast (~2s) and focused on the ingest contract.
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
const USER_EMAIL = "alice@example.invalid";

interface Env {
	pg: StartedTestContainer;
	db: Db;
	server: Server;
	baseUrl: string;
	tempDir: string;
	bearerJwt: string;
	databaseUrl: string;
}

let env: Env | undefined;

beforeAll(async () => {
	env = await setupEnv();
}, TEST_TIMEOUT);

afterAll(async () => {
	if (env) await teardownEnv(env);
}, TEST_TIMEOUT);

describe("POST /v1/traces — OTLP ingest", () => {
	it(
		"accepts a valid payload, ignores agent.user.id, writes rows with the authenticated user_id",
		async () => {
			if (!env) throw new Error("test environment failed to set up");
			const e = env;

			const beforeCount = await countSpendLogs(e);
			const payload = makePayload([
				makeSpan({ harnessName: "pi", model: "glm-4.6", inputTokens: 100, outputTokens: 50 }),
				makeSpan({ harnessName: "pi", model: "glm-4.6", inputTokens: 200, outputTokens: 75 }),
				// Forged identity attempt — must be ignored. The row's
				// user_id should still be USER_EMAIL.
				makeSpan({
					harnessName: "pi",
					model: "glm-4.6",
					inputTokens: 1,
					outputTokens: 1,
					claimedUserId: "ceo@example.invalid",
				}),
			]);

			const res = await fetch(`${e.baseUrl}/v1/traces`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${e.bearerJwt}`,
				},
				body: JSON.stringify(payload),
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ partialSuccess: {} });

			const afterCount = await countSpendLogs(e);
			expect(afterCount - beforeCount).toBe(3);

			const rows = await fetchRecentRows(e, USER_EMAIL, 3);
			expect(rows.every((r) => r.user_id === USER_EMAIL)).toBe(true);
			expect(rows.every((r) => r.harness_name === "pi")).toBe(true);
			expect(rows.every((r) => r.model === "glm-4.6")).toBe(true);

			// Specifically: NO row got user_id=ceo@example.invalid. (D8)
			expect(await countByUserId(e, "ceo@example.invalid")).toBe(0);
		},
		TEST_TIMEOUT,
	);

	it(
		"rejects requests without a bearer token (cookie path is forbidden on /v1/traces)",
		async () => {
			if (!env) throw new Error("test environment failed to set up");
			const e = env;
			const res = await fetch(`${e.baseUrl}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe("no token");
		},
		TEST_TIMEOUT,
	);

	it(
		"reports skipped spans in partialSuccess when required attrs are missing",
		async () => {
			if (!env) throw new Error("test environment failed to set up");
			const e = env;
			const payload = makePayload([
				makeSpan({ harnessName: "pi", model: "glm-4.6", inputTokens: 1, outputTokens: 1 }),
				// Missing harness name — should be skipped.
				{
					startTimeUnixNano: "1700000000000000000",
					attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "z.ai" } }],
				},
			]);
			const res = await fetch(`${e.baseUrl}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${e.bearerJwt}` },
				body: JSON.stringify(payload),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { partialSuccess: { rejectedSpans?: number } };
			expect(body.partialSuccess.rejectedSpans).toBe(1);
		},
		TEST_TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

async function setupEnv(): Promise<Env> {
	const tempDir = await mkdtemp(join(tmpdir(), "agent-spend-ingest-"));

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

	// Seed: a user + an api_tokens row for the bearer the test uses.
	const userRow = await db.insertUser({ email: USER_EMAIL, name: "Alice", role: "developer" });
	const userId = await db.findUserIdByEmail(userRow.email);
	if (!userId) throw new Error("failed to read back inserted user id");

	const secret = new TextEncoder().encode(JWT_SECRET);
	const bearerJwt = await new SignJWT({
		email: USER_EMAIL,
		name: "Alice",
		role: "developer",
		machine: "test-machine",
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(USER_EMAIL)
		.setIssuedAt()
		.setExpirationTime("90d")
		.sign(secret);

	await db.insertApiToken({
		userId,
		label: "test-machine",
		tokenHash: sha256Hex(bearerJwt),
		expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
	});

	const app = createApp({
		publicUrl: baseUrl,
		jwtSecret: JWT_SECRET,
		oidc: {} as OidcContext, // /v1/traces doesn't touch OIDC
		db,
	});
	const server: Server = await new Promise((resolve) => {
		const s = app.listen(apiPort, () => resolve(s));
	});

	return { pg, db, server, baseUrl, tempDir, bearerJwt, databaseUrl };
}

async function teardownEnv(e: Env): Promise<void> {
	await new Promise<void>((resolve) => e.server.close(() => resolve()));
	await e.db.close();
	await e.pg.stop({ timeout: 5000 });
	await rm(e.tempDir, { recursive: true, force: true });
}

async function countSpendLogs(e: Env): Promise<number> {
	const pool = new Pool({ connectionString: e.databaseUrl });
	try {
		const r = await pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM agent_spend_logs");
		return Number.parseInt(r.rows[0]?.c ?? "0", 10);
	} finally {
		await pool.end();
	}
}

async function countByUserId(e: Env, userId: string): Promise<number> {
	const pool = new Pool({ connectionString: e.databaseUrl });
	try {
		const r = await pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM agent_spend_logs WHERE user_id = $1", [
			userId,
		]);
		return Number.parseInt(r.rows[0]?.c ?? "0", 10);
	} finally {
		await pool.end();
	}
}

async function fetchRecentRows(
	e: Env,
	userId: string,
	limit: number,
): Promise<Array<{ user_id: string; harness_name: string; model: string; input_tokens: number }>> {
	const pool = new Pool({ connectionString: e.databaseUrl });
	try {
		const r = await pool.query(
			"SELECT user_id, harness_name, model, input_tokens FROM agent_spend_logs WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
			[userId, limit],
		);
		return r.rows;
	} finally {
		await pool.end();
	}
}

// ---------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------

interface MakeSpanOpts {
	readonly harnessName?: string;
	readonly model?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly claimedUserId?: string;
}

function makeSpan(opts: MakeSpanOpts): Record<string, unknown> {
	const attrs: Array<{ key: string; value: Record<string, unknown> }> = [];
	if (opts.harnessName) attrs.push(attr("agent.harness.name", opts.harnessName));
	if (opts.model) {
		attrs.push(attr("gen_ai.request.model", opts.model));
		attrs.push(attr("gen_ai.response.model", opts.model));
	}
	attrs.push(attr("gen_ai.provider.name", "z.ai"));
	attrs.push(attr("agent.api.dialect", "anthropic-messages"));
	attrs.push(attr("agent.machine.id", "11111111-1111-1111-1111-111111111111"));
	attrs.push(attr("agent.session.id", "22222222-2222-2222-2222-222222222222"));
	attrs.push(attr("gen_ai.usage.input_tokens", opts.inputTokens ?? 0, "intValue"));
	attrs.push(attr("gen_ai.usage.output_tokens", opts.outputTokens ?? 0, "intValue"));
	attrs.push(attr("agent.cost.input.usd", 0.001, "doubleValue"));
	attrs.push(attr("agent.cost.output.usd", 0.002, "doubleValue"));
	attrs.push(attr("agent.cost.total.usd", 0.003, "doubleValue"));
	if (opts.claimedUserId) attrs.push(attr("agent.user.id", opts.claimedUserId));
	return { startTimeUnixNano: "1700000000000000000", attributes: attrs };
}

function attr(key: string, value: unknown, vtype = "stringValue"): { key: string; value: Record<string, unknown> } {
	return { key, value: { [vtype]: value } };
}

function makePayload(spans: Array<Record<string, unknown>>): Record<string, unknown> {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [attr("service.name", "pi-usage-reporter"), attr("deployment.environment", "lab")],
				},
				scopeSpans: [{ scope: { name: "test" }, spans }],
			},
		],
	};
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
