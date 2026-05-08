/**
 * Server configuration.
 *
 * Reads environment variables with defaults. Per the design doc §10, every
 * value an organization would change at deploy time is parameterized.
 *
 * For phase 0.3.1, the surface is intentionally tiny: PORT and PUBLIC_URL.
 * Auth, database, and ingest config land in subsequent phases.
 */

export interface Config {
	readonly port: number;
	readonly publicUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const port = parsePort(env["PORT"], 8080);
	const publicUrl = env["PUBLIC_URL"]?.trim() || `http://localhost:${port}`;
	return { port, publicUrl };
}

function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
		throw new Error(`Invalid PORT: ${JSON.stringify(value)} (expected 1-65535)`);
	}
	return parsed;
}
