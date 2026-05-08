import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
	DATABASE_URL: "postgresql://localhost/test",
	AGENT_SPEND_JWT_SECRET: "test-secret",
	AGENT_SPEND_OIDC_ISSUER_URL: "http://idp.localhost:7019",
	AGENT_SPEND_OIDC_CLIENT_ID: "agent-spend",
	AGENT_SPEND_OIDC_CLIENT_SECRET: "test-client-secret",
};

describe("loadConfig", () => {
	it("returns defaults when only required env is set", () => {
		const cfg = loadConfig({ ...baseEnv });
		expect(cfg.port).toBe(8080);
		expect(cfg.publicUrl).toBe("http://localhost:8080");
		expect(cfg.databaseUrl).toBe(baseEnv.DATABASE_URL);
		expect(cfg.jwtSecret).toBe(baseEnv.AGENT_SPEND_JWT_SECRET);
		expect(cfg.oidc.issuerUrl).toBe(baseEnv.AGENT_SPEND_OIDC_ISSUER_URL);
		expect(cfg.oidc.clientId).toBe(baseEnv.AGENT_SPEND_OIDC_CLIENT_ID);
		expect(cfg.oidc.clientSecret).toBe(baseEnv.AGENT_SPEND_OIDC_CLIENT_SECRET);
	});

	it("respects PORT", () => {
		const cfg = loadConfig({ ...baseEnv, PORT: "9999" });
		expect(cfg.port).toBe(9999);
		expect(cfg.publicUrl).toBe("http://localhost:9999");
	});

	it("respects PUBLIC_URL", () => {
		const cfg = loadConfig({ ...baseEnv, PUBLIC_URL: "https://dashboard.example.com" });
		expect(cfg.publicUrl).toBe("https://dashboard.example.com");
	});

	it("trims whitespace from PUBLIC_URL", () => {
		const cfg = loadConfig({ ...baseEnv, PUBLIC_URL: "  https://example.com  " });
		expect(cfg.publicUrl).toBe("https://example.com");
	});

	it("throws on non-numeric PORT", () => {
		expect(() => loadConfig({ ...baseEnv, PORT: "not-a-port" })).toThrow(/Invalid PORT/);
	});

	it("throws on out-of-range PORT", () => {
		expect(() => loadConfig({ ...baseEnv, PORT: "70000" })).toThrow(/Invalid PORT/);
		expect(() => loadConfig({ ...baseEnv, PORT: "0" })).toThrow(/Invalid PORT/);
	});

	it("throws when AGENT_SPEND_JWT_SECRET is missing", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		expect(() => loadConfig(env)).toThrow(/AGENT_SPEND_JWT_SECRET/);
	});

	it("throws when DATABASE_URL is missing", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
	});

	it("throws when any OIDC variable is missing", () => {
		for (const name of [
			"AGENT_SPEND_OIDC_ISSUER_URL",
			"AGENT_SPEND_OIDC_CLIENT_ID",
			"AGENT_SPEND_OIDC_CLIENT_SECRET",
		]) {
			const env = { ...baseEnv } as Record<string, string | undefined>;
			env[name] = undefined;
			expect(() => loadConfig(env)).toThrow(new RegExp(name));
		}
	});
});
