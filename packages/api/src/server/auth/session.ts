/**
 * Session cookie helpers.
 *
 * The session is a JWT (HS256) signed with `AGENT_SPEND_JWT_SECRET`,
 * carried by an HttpOnly + SameSite=Lax cookie. Per the auth strategy
 * §6.1, browser sessions are short — 24h TTL.
 *
 * Phase 0.3.3 only needs the session-cookie path. Per-machine bearer
 * tokens, the api_tokens table, and bcrypt-hashed token storage are
 * deferred to phase 0.3.6 per the design's gantt.
 */

import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { Request, Response } from "express";
import { jwtVerify, SignJWT } from "jose";

const SESSION_COOKIE = "agent_spend_session";
const FLOW_COOKIE = "agent_spend_oidc_flow";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface SessionClaims {
	readonly sub: string;
	readonly email: string;
	readonly name: string | null;
	readonly role: "admin" | "developer";
}

/**
 * Mint a session JWT, set the HttpOnly cookie, return the token string
 * for callers that also want to log it (the test harness uses this).
 */
export async function issueSession(res: Response, jwtSecret: string, claims: SessionClaims): Promise<string> {
	const secret = new TextEncoder().encode(jwtSecret);
	const token = await new SignJWT({
		email: claims.email,
		name: claims.name,
		role: claims.role,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(claims.sub)
		.setIssuedAt()
		.setExpirationTime(`${SESSION_TTL_SECONDS}s`)
		.sign(secret);

	res.append(
		"Set-Cookie",
		serializeCookie(SESSION_COOKIE, token, {
			httpOnly: true,
			sameSite: "lax",
			path: "/",
			maxAge: SESSION_TTL_SECONDS,
			// `secure` is left off for the lab (http://). Production deployments
			// terminate TLS at the edge and should set PUBLIC_URL=https://...,
			// at which point the cookie path here would also flip secure=true.
			// We add that branch in phase 0.3.5 alongside LAB_NO_AUTH.
		}),
	);
	return token;
}

/** Read the session cookie and validate the JWT; null if missing/invalid. */
export async function readSession(req: Request, jwtSecret: string): Promise<SessionClaims | null> {
	const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
	if (!raw) return null;
	try {
		const secret = new TextEncoder().encode(jwtSecret);
		const { payload } = await jwtVerify(raw, secret, { algorithms: ["HS256"] });
		const sub = payload.sub;
		const email = typeof payload["email"] === "string" ? payload["email"] : undefined;
		const role = payload["role"];
		const name = typeof payload["name"] === "string" ? payload["name"] : null;
		if (!sub || !email || (role !== "admin" && role !== "developer")) return null;
		return { sub, email, name, role };
	} catch {
		return null;
	}
}

export function clearSession(res: Response): void {
	res.append(
		"Set-Cookie",
		serializeCookie(SESSION_COOKIE, "", {
			httpOnly: true,
			sameSite: "lax",
			path: "/",
			maxAge: 0,
		}),
	);
}

/**
 * Short-lived cookie that carries the in-flight OIDC state, PKCE
 * verifier, and nonce between /auth/login and /auth/callback. We
 * deliberately use a cookie (not server-side state) so the API stays
 * stateless across instances.
 */

export interface FlowState {
	readonly state: string;
	readonly codeVerifier: string;
	readonly nonce: string;
	readonly returnTo: string;
}

export function setFlowCookie(res: Response, flow: FlowState): void {
	res.append(
		"Set-Cookie",
		serializeCookie(FLOW_COOKIE, JSON.stringify(flow), {
			httpOnly: true,
			sameSite: "lax",
			path: "/auth",
			maxAge: 5 * 60, // 5 minutes — long enough for IdP login, short enough to bound replay
		}),
	);
}

export function readFlowCookie(req: Request): FlowState | null {
	const raw = parseCookies(req.headers.cookie)[FLOW_COOKIE];
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof parsed["state"] !== "string" ||
			typeof parsed["codeVerifier"] !== "string" ||
			typeof parsed["nonce"] !== "string" ||
			typeof parsed["returnTo"] !== "string"
		) {
			return null;
		}
		return {
			state: parsed["state"],
			codeVerifier: parsed["codeVerifier"],
			nonce: parsed["nonce"],
			returnTo: parsed["returnTo"],
		};
	} catch {
		return null;
	}
}

export function clearFlowCookie(res: Response): void {
	res.append(
		"Set-Cookie",
		serializeCookie(FLOW_COOKIE, "", {
			httpOnly: true,
			sameSite: "lax",
			path: "/auth",
			maxAge: 0,
		}),
	);
}

function parseCookies(header: string | undefined): Record<string, string> {
	if (!header) return {};
	const parsed = parseCookie(header);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}
