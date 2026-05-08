import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OidcContext } from "./auth/oidc.js";
import type { ActiveTokenRow, Db, InsertApiTokenInput, UserRole, UserRow } from "./db.js";

/**
 * createApp's deps include a real OidcContext and a Db. For the
 * non-auth surface (`/health`, `/`, unauthenticated `/api/me`) we don't
 * need either to actually function — only their shapes — so we cast
 * minimal placeholders. The full OIDC flow is covered by
 * auth/oidc.integration.test.ts (testcontainers); the requireAuth
 * middleware is unit-tested in auth/middleware.test.ts.
 */
function makeFakeDb(): Db {
	const users: UserRow[] = [];
	return {
		async countUsers() {
			return users.length;
		},
		async findUserByEmail(email) {
			return users.find((u) => u.email === email) ?? null;
		},
		async findUserIdByEmail() {
			return null;
		},
		async insertUser({ email, name, role }: { email: string; name: string | null; role: UserRole }) {
			const row: UserRow = { email, name, role };
			users.push(row);
			return row;
		},
		async findActiveTokenByHash(): Promise<ActiveTokenRow | null> {
			return null;
		},
		async markTokenUsed() {},
		async insertApiToken(_input: InsertApiTokenInput) {
			return { id: 0 };
		},
		async revokeApiToken() {},
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

const deps = {
	publicUrl: "http://localhost:8080",
	jwtSecret: "test-secret",
	oidc: {} as OidcContext,
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

	it("GET / returns the placeholder HTML with login link when anonymous", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toMatch(/text\/html/);
			const body = await res.text();
			expect(body).toContain("Agent Spend");
			expect(body).toContain("/auth/login");
		});
	});

	it("GET /api/me returns 401 when no token", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/api/me`);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("no token");
		});
	});

	it("POST /auth/logout clears the cookie and returns 204", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/auth/logout`, { method: "POST" });
			expect(res.status).toBe(204);
			const setCookie = res.headers.get("set-cookie") ?? "";
			expect(setCookie).toMatch(/agent_spend_session=/);
			expect(setCookie).toMatch(/Max-Age=0/i);
		});
	});

	it("does not advertise X-Powered-By", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.headers.get("x-powered-by")).toBeNull();
		});
	});
});
