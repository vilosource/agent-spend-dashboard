import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const deps = { publicUrl: "http://localhost:8080" };

/**
 * We use Node's built-in fetch against the app via supertest-style ad-hoc
 * binding: app.listen(0) lets the OS pick a free port. This avoids adding
 * supertest as a devDependency just for two tests.
 */
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

	it("GET / returns the placeholder HTML", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toMatch(/text\/html/);
			const body = await res.text();
			expect(body).toContain("Agent Spend");
			expect(body).toContain("phase 0.3.9");
		});
	});

	it("does not advertise X-Powered-By", async () => {
		await withRunningApp(async (baseUrl) => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.headers.get("x-powered-by")).toBeNull();
		});
	});
});
