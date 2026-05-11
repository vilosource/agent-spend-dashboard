import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
	DATABASE_URL: "postgresql://localhost/test",
	TOKEN_TRACKER_OIDC_ISSUER_URL: "https://idp.example.invalid/tenant/v2.0",
	TOKEN_TRACKER_OIDC_CLIENT_ID: "token-tracker-api",
};

describe("loadConfig", () => {
	it("returns defaults when only required env is set", () => {
		const cfg = loadConfig({ ...baseEnv });
		expect(cfg.port).toBe(8080);
		expect(cfg.publicUrl).toBe("http://localhost:8080");
		expect(cfg.databaseUrl).toBe(baseEnv.DATABASE_URL);
		expect(cfg.oidc.issuerUrl).toBe(baseEnv.TOKEN_TRACKER_OIDC_ISSUER_URL);
		expect(cfg.oidc.clientId).toBe(baseEnv.TOKEN_TRACKER_OIDC_CLIENT_ID);
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

	it("throws when DATABASE_URL is missing", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
	});

	it("throws when any OIDC variable is missing", () => {
		for (const name of ["TOKEN_TRACKER_OIDC_ISSUER_URL", "TOKEN_TRACKER_OIDC_CLIENT_ID"]) {
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
		tmp = mkdtempSync(join(tmpdir(), "token-tracker-cfg-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const writeSecret = (name: string, value: string): string => {
		const path = join(tmp, name);
		writeFileSync(path, value);
		return path;
	};

	it("reads DATABASE_URL from _FILE when set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		env["DATABASE_URL_FILE"] = writeSecret("db", "postgresql://from-file-host/db");
		expect(loadConfig(env).databaseUrl).toBe("postgresql://from-file-host/db");
	});

	it("trims whitespace from file contents", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["TOKEN_TRACKER_OIDC_CLIENT_ID"] = undefined;
		env["TOKEN_TRACKER_OIDC_CLIENT_ID_FILE"] = writeSecret("cid", "  trimmed-id\n");
		expect(loadConfig(env).oidc.clientId).toBe("trimmed-id");
	});

	it("_FILE wins when both _FILE and the bare env var are set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["TOKEN_TRACKER_OIDC_ISSUER_URL"] = "https://bare.example.invalid";
		env["TOKEN_TRACKER_OIDC_ISSUER_URL_FILE"] = writeSecret("iss", "https://from-file.example.invalid");
		expect(loadConfig(env).oidc.issuerUrl).toBe("https://from-file.example.invalid");
	});

	it("throws clearly when _FILE points at a missing path", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		env["DATABASE_URL_FILE"] = "/nonexistent/path/db";
		expect(() => loadConfig(env)).toThrow(/DATABASE_URL_FILE/);
	});

	it("throws clearly when _FILE points at an empty file", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		env["DATABASE_URL_FILE"] = writeSecret("empty", "");
		expect(() => loadConfig(env)).toThrow(/empty/);
	});

	it("error message mentions both <NAME> and <NAME>_FILE when neither is set", () => {
		const env = { ...baseEnv } as Record<string, string | undefined>;
		env["DATABASE_URL"] = undefined;
		expect(() => loadConfig(env)).toThrow(/DATABASE_URL.*DATABASE_URL_FILE/s);
	});
});
