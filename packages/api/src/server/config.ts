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
 */

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
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
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
