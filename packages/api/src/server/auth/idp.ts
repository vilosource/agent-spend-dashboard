/**
 * IdP access-token verifier.
 *
 * The server is a pure OAuth 2.0 resource server (token-tracker-redesign-DESIGN.md
 * §2, §4.1): every authenticated request — SPA browser, CLI reporter, future
 * integrations — carries an access token signed by the IdP. The server verifies
 * the signature against the IdP's published JWKs and never issues a token of any
 * kind.
 *
 * Discovery + JWKs fetch are lazy (first authenticated request) and memoised; a
 * failure is retryable on the next request rather than a boot-time crash. The
 * JWKs set itself is managed by jose's `createRemoteJWKSet`, which caches keys,
 * re-fetches on a `kid` miss (subject to a cooldown), and times out cleanly —
 * exactly the "refresh on key rotation" behaviour the design calls for.
 *
 * What we verify, per §4.1: signature (RS256/ES256), `iss` (against the issuer
 * the discovery doc advertises), `aud` (our app's client id), `exp`/`nbf`.
 * Identity is `{ email, oid, name, roles[] }`; `roles` drives authorization
 * (see middleware.ts). Role is never persisted — it is read from the token
 * every request (D7).
 */

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { OidcConfig } from "../config.js";

/** Claims extracted from a verified access token. */
export interface VerifiedToken {
	/** Lowercased; from `upn`, then `preferred_username`, then `email`. */
	readonly email: string;
	/** Stable IdP object id, if present. We still key on email. */
	readonly oid: string | null;
	readonly name: string | null;
	/** App-role claims, verbatim (e.g. `["TokenTracker.User"]`). */
	readonly roles: readonly string[];
}

export type AuthFailureKind =
	/** The token is missing, malformed, expired, wrong-audience, or forged. → 401. */
	| "invalid"
	/** The IdP (discovery doc or JWKs endpoint) couldn't be reached. → 503. */
	| "unavailable";

export class AuthError extends Error {
	constructor(
		readonly kind: AuthFailureKind,
		message: string,
	) {
		super(message);
		this.name = "AuthError";
	}
}

export interface Verifier {
	verifyAccessToken(token: string): Promise<VerifiedToken>;
}

const DISCOVERY_TIMEOUT_MS = 5000;

export function createVerifier(cfg: OidcConfig): Verifier {
	const issuerUrl = cfg.issuerUrl.replace(/\/+$/, "");
	// Entra exposes the resource either as the bare client id or as `api://<id>`;
	// accept both so the deploying app doesn't have to special-case its app
	// registration's "Application ID URI".
	const audiences = [cfg.clientId, `api://${cfg.clientId}`];

	let pending: Promise<{ issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }> | null = null;

	function load(): Promise<{ issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }> {
		if (!pending) {
			pending = (async () => {
				const discovery = await fetchDiscovery(issuerUrl);
				return { issuer: discovery.issuer, jwks: createRemoteJWKSet(new URL(discovery.jwksUri)) };
			})().catch((err: unknown) => {
				pending = null; // let the next request retry discovery
				throw new AuthError("unavailable", `OIDC discovery failed for ${issuerUrl}: ${describe(err)}`);
			});
		}
		return pending;
	}

	return {
		async verifyAccessToken(token: string): Promise<VerifiedToken> {
			const { issuer, jwks } = await load();
			let payload: JWTPayload;
			try {
				({ payload } = await jwtVerify(token, jwks, {
					issuer,
					audience: audiences,
					algorithms: ["RS256", "ES256"],
				}));
			} catch (err: unknown) {
				if (isJwksUnavailable(err)) {
					throw new AuthError("unavailable", `JWKs unavailable: ${describe(err)}`);
				}
				throw new AuthError("invalid", `token verification failed: ${describe(err)}`);
			}
			const email = pickEmail(payload);
			if (!email) {
				throw new AuthError("invalid", "token has no usable upn / preferred_username / email claim");
			}
			return {
				email,
				oid: typeof payload["oid"] === "string" ? payload["oid"] : null,
				name: typeof payload["name"] === "string" ? payload["name"] : null,
				roles: extractRoles(payload),
			};
		},
	};
}

interface Discovery {
	readonly issuer: string;
	readonly jwksUri: string;
}

async function fetchDiscovery(issuerUrl: string): Promise<Discovery> {
	const url = `${issuerUrl}/.well-known/openid-configuration`;
	const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
	if (!res.ok) {
		throw new Error(`GET ${url} returned ${res.status}`);
	}
	const doc = (await res.json()) as Record<string, unknown>;
	const issuer = typeof doc["issuer"] === "string" ? doc["issuer"] : null;
	const jwksUri = typeof doc["jwks_uri"] === "string" ? doc["jwks_uri"] : null;
	if (!issuer || !jwksUri) {
		throw new Error(`discovery doc at ${url} is missing "issuer" or "jwks_uri"`);
	}
	return { issuer, jwksUri };
}

function pickEmail(payload: JWTPayload): string | null {
	for (const claim of ["upn", "preferred_username", "email"] as const) {
		const value = payload[claim];
		if (typeof value === "string" && value.includes("@")) return value.toLowerCase();
	}
	return null;
}

function extractRoles(payload: JWTPayload): readonly string[] {
	const roles = payload["roles"];
	if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === "string");
	return [];
}

/** A network/timeout failure reaching the JWKs endpoint (vs. a bad token). */
function isJwksUnavailable(err: unknown): boolean {
	if (err instanceof TypeError) return true; // fetch() network error
	const code = (err as { code?: unknown }).code;
	return code === "ERR_JWKS_TIMEOUT";
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
