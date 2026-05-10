/**
 * Server configuration.
 *
 * Reads environment variables. App-specific names use the
 * `AGENT_SPEND_*` prefix so they don't collide with generic env vars
 * other applications on the same host might also define
 * (`JWT_SECRET`, `OIDC_ISSUER_URL`, etc.).
 *
 * Generic 12-factor names (`PORT`, `PUBLIC_URL`, `DATABASE_URL`) keep
 * their conventional form.
 *
 * **Docker-secrets pattern.** Every `required` value also accepts a
 * `<NAME>_FILE` variant whose value is a filesystem path; the file's
 * trimmed contents become the value. This is the standard convention
 * for sourcing secrets from Docker Swarm secrets, Kubernetes secret
 * mounts, etc., without having to template the value into a plaintext
 * env var. If both `<NAME>` and `<NAME>_FILE` are set, `_FILE` wins.
 */

import { readFileSync } from "node:fs";

export interface OidcConfig {
	readonly issuerUrl: string;
	readonly clientId: string;
	readonly clientSecret: string;
}

export interface Config {
	readonly port: number;
	readonly publicUrl: string;
	readonly databaseUrl: string;
	readonly jwtSecret: string;
	readonly oidc: OidcConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const port = parsePort(env["PORT"], 8080);
	const publicUrl = env["PUBLIC_URL"]?.trim() || `http://localhost:${port}`;
	const databaseUrl = required(env, "DATABASE_URL");
	const jwtSecret = required(env, "AGENT_SPEND_JWT_SECRET");
	const oidc: OidcConfig = {
		issuerUrl: required(env, "AGENT_SPEND_OIDC_ISSUER_URL"),
		clientId: required(env, "AGENT_SPEND_OIDC_CLIENT_ID"),
		clientSecret: required(env, "AGENT_SPEND_OIDC_CLIENT_SECRET"),
	};
	return { port, publicUrl, databaseUrl, jwtSecret, oidc };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	// Docker-secrets convention: <NAME>_FILE wins over <NAME>.
	const filePath = env[`${name}_FILE`]?.trim();
	if (filePath) {
		try {
			const fromFile = readFileSync(filePath, "utf8").trim();
			if (!fromFile) {
				throw new Error(`File is empty: ${filePath}`);
			}
			return fromFile;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to read ${name}_FILE=${filePath}: ${reason}`);
		}
	}
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name} (or ${name}_FILE)`);
	}
	return value;
}

function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
		throw new Error(`Invalid PORT: ${JSON.stringify(value)} (expected 1-65535)`);
	}
	return parsed;
}
