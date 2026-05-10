import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// Docker-secrets pattern: every required value also accepts <NAME>_FILE
// pointing at a filesystem path whose trimmed contents become the value.
describe("loadConfig — *_FILE Docker-secrets fallback", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "agent-spend-cfg-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const writeSecret = (name: string, value: string): string => {
		const path = join(tmp, name);
		writeFileSync(path, value);
		return path;
	};

	it("reads AGENT_SPEND_JWT_SECRET from _FILE when set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		env["AGENT_SPEND_JWT_SECRET_FILE"] = writeSecret("jwt", "from-file-secret");
		const cfg = loadConfig(env);
		expect(cfg.jwtSecret).toBe("from-file-secret");
	});

	it("trims whitespace from file contents", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		env["AGENT_SPEND_JWT_SECRET_FILE"] = writeSecret("jwt", "  trimmed-secret\n");
		const cfg = loadConfig(env);
		expect(cfg.jwtSecret).toBe("trimmed-secret");
	});

	it("_FILE wins when both _FILE and the bare env var are set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = "bare-env-value";
		env["AGENT_SPEND_JWT_SECRET_FILE"] = writeSecret("jwt", "file-value");
		const cfg = loadConfig(env);
		expect(cfg.jwtSecret).toBe("file-value");
	});

	it("works for DATABASE_URL_FILE", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		env["DATABASE_URL_FILE"] = writeSecret("db", "postgresql://from-file-host/db");
		const cfg = loadConfig(env);
		expect(cfg.databaseUrl).toBe("postgresql://from-file-host/db");
	});

	it("works for AGENT_SPEND_OIDC_CLIENT_SECRET_FILE", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_OIDC_CLIENT_SECRET"] = undefined;
		env["AGENT_SPEND_OIDC_CLIENT_SECRET_FILE"] = writeSecret("oidc-cs", "file-client-secret");
		const cfg = loadConfig(env);
		expect(cfg.oidc.clientSecret).toBe("file-client-secret");
	});

	it("works for AGENT_SPEND_OIDC_CLIENT_ID_FILE", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_OIDC_CLIENT_ID"] = undefined;
		env["AGENT_SPEND_OIDC_CLIENT_ID_FILE"] = writeSecret("oidc-cid", "file-client-id");
		const cfg = loadConfig(env);
		expect(cfg.oidc.clientId).toBe("file-client-id");
	});

	it("throws clearly when _FILE points at a missing path", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		env["AGENT_SPEND_JWT_SECRET_FILE"] = "/nonexistent/path/jwt";
		expect(() => loadConfig(env)).toThrow(/AGENT_SPEND_JWT_SECRET_FILE/);
	});

	it("throws clearly when _FILE points at an empty file", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		env["AGENT_SPEND_JWT_SECRET_FILE"] = writeSecret("empty", "");
		expect(() => loadConfig(env)).toThrow(/empty/);
	});

	it("error message mentions both <NAME> and <NAME>_FILE when neither is set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["AGENT_SPEND_JWT_SECRET"] = undefined;
		expect(() => loadConfig(env)).toThrow(/AGENT_SPEND_JWT_SECRET.*AGENT_SPEND_JWT_SECRET_FILE/s);
	});
});
