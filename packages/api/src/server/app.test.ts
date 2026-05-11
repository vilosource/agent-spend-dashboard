import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AuthError, type Verifier } from "./auth/idp.js";
import type { Db } from "./db.js";

/**
 * createApp's deps are a `Verifier` and a `Db`. The non-auth surface
 * exercised here (`/health`, `/`, unauthenticated `/api/me`) never
 * reaches a successful token verification, so a stub verifier and a
 * no-op fake Db are enough. The verifier itself is unit-tested in
 * auth/idp.test.ts; the middleware in auth/middleware.test.ts.
 */
function makeFakeDb(): Db {
	return {
		async upsertUser() {},
		async insertSpendLogs() {},
		async fetchUsageTotals() {
			return { costUsd: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
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
		async close() {},
	};
}

const stubVerifier: Verifier = {
	async verifyAccessToken() {
		throw new AuthError("invalid", "no real tokens are exercised in these tests");
	},
};

const deps = {
	publicUrl: "http://localhost:8080",
	verifier: stubVerifier,
	db: makeFakeDb(),
};

async function withRunningApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
	const app = createApp(deps);
	const server = app.listen(0);
	try {
		const address = server.address();
		if (typeof address !== "object" || address === null) {
			throw new Error("expected server address to be an object");
		}
		const baseUrl = `http://127.0.0.1:${address.port}`;
		return await fn(baseUrl);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("createApp", () => {
	it("GET /health returns { status: 'ok', version }", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; version: string };
			expect(body.status).toBe("ok");
			expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		});
	});

	it("GET / returns 503 + a clear 'build the SPA' message when the bundle is missing", async () => {
		// In the test process import.meta.url resolves to .../packages/api/src/server/app.ts,
		// so SPA_DIR resolves to packages/api/src/spa (which never exists). This is the
		// dev-time path before someone runs `npm run -w @vilosource/token-tracker-spa build`.
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/`);
			expect(res.status).toBe(503);
			expect(res.headers.get("content-type")).toMatch(/text\/html/);
			const body = await res.text();
			expect(body).toContain("Token Tracker");
			expect(body).toContain("token-tracker-spa");
		});
	});

	it("GET /api/me returns 401 'no token' when no Authorization header is sent", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/api/me`);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("no token");
		});
	});

	it("does not advertise X-Powered-By", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.headers.get("x-powered-by")).toBeNull();
		});
	});
});
