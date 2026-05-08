import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OidcContext } from "./auth/oidc.js";
import type { Db, UserRole, UserRow } from "./db.js";

/**
 * createApp's deps include a real OidcContext and a Db. For the
 * non-auth surface (`/health`, `/`, anonymous `/api/me`) we don't need
 * either to actually function — only their shapes — so we cast minimal
 * placeholders. Auth-flow integration is covered separately by
 * auth/auth.test.ts which spins up a real Dex via testcontainers.
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
		async insertUser({ email, name, role }: { email: string; name: string | null; role: UserRole }) {
			const row: UserRow = { email, name, role };
			users.push(row);
			return row;
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

	it("GET /api/me returns 401 when no session cookie", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/api/me`);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("unauthenticated");
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
