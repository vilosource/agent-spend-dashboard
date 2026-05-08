/**
 * `requireAuth` middleware — phase 0.3.6.
 *
 * Both transports (browser cookie, extension `Authorization: Bearer`)
 * carry the same JWT format. The middleware validates the signature
 * once, then takes one of two paths based on transport:
 *
 *   • cookie  → stateless. Identity from claims. No DB lookup. (D14)
 *   • bearer  → DB-backed. SHA-256(token) → api_tokens row lookup.
 *               Reject if revoked or expired. Update last_used_at
 *               inline. Identity comes from the row + claims.
 *
 * Downstream handlers see one shape on `req.identity` regardless of
 * how the user authenticated.
 */

import { parse as parseCookie } from "cookie";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { jwtVerify } from "jose";
import type { Db, UserRole } from "../db.js";
import { sha256Hex } from "./tokens.js";

export type AuthSource = "cookie" | "bearer";

export interface Identity {
	readonly userId: number | null; // null for cookie path until we wire user_id into the JWT (0.3.6 keeps email-as-identity)
	readonly email: string;
	readonly name: string | null;
	readonly role: UserRole;
	readonly tokenLabel: string; // "browser" for cookie path, the row's label for bearer
	readonly source: AuthSource;
}

declare module "express-serve-static-core" {
	interface Request {
		identity?: Identity;
	}
}

const SESSION_COOKIE = "agent_spend_session";

export interface RequireAuthDeps {
	readonly db: Db;
	readonly jwtSecret: string;
}

export function requireAuth(deps: RequireAuthDeps): RequestHandler {
	const secret = new TextEncoder().encode(deps.jwtSecret);

	return async (req: Request, res: Response, next: NextFunction) => {
		const transport = bearerOrCookie(req);
		if (!transport) return reject(res, 401, "no token");

		const verified = await verifyAndExtract(transport.token, secret);
		if (verified.kind === "invalid-signature") return reject(res, 401, "invalid token");
		if (verified.kind === "invalid-claims") return reject(res, 401, "invalid token claims");

		if (transport.source === "cookie") {
			req.identity = { userId: null, ...verified.claims, tokenLabel: "browser", source: "cookie" };
			return next();
		}

		const row = await deps.db.findActiveTokenByHash(sha256Hex(transport.token));
		if (!row) return reject(res, 401, "revoked or expired");

		// Inline UPDATE per D14; batching deferred to 0.3.7. Fire-and-forget
		// off the critical path; log on failure.
		void deps.db.markTokenUsed(row.tokenId).catch((err) => {
			console.error("markTokenUsed failed:", err);
		});

		req.identity = {
			userId: row.userId,
			email: row.email,
			name: verified.claims.name,
			role: row.role,
			tokenLabel: row.label,
			source: "bearer",
		};
		next();
	};
}

type VerifyResult =
	| { kind: "ok"; claims: { email: string; name: string | null; role: UserRole } }
	| { kind: "invalid-signature" }
	| { kind: "invalid-claims" };

async function verifyAndExtract(token: string, secret: Uint8Array): Promise<VerifyResult> {
	let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
	try {
		({ payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] }));
	} catch {
		return { kind: "invalid-signature" };
	}
	const email = typeof payload["email"] === "string" ? payload["email"] : null;
	const name = typeof payload["name"] === "string" ? payload["name"] : null;
	const role = payload["role"];
	if (!email || (role !== "admin" && role !== "developer")) {
		return { kind: "invalid-claims" };
	}
	return { kind: "ok", claims: { email, name, role } };
}

function reject(res: Response, status: number, error: string): void {
	res.status(status).json({ error });
}

interface ExtractedToken {
	readonly token: string;
	readonly source: AuthSource;
}

export function bearerOrCookie(req: Request): ExtractedToken | null {
	const authHeader = req.headers.authorization;
	if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
		const token = authHeader.slice("Bearer ".length).trim();
		if (token.length > 0) return { token, source: "bearer" };
	}

	const cookieHeader = req.headers.cookie;
	if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
		const parsed = parseCookie(cookieHeader);
		const value = parsed[SESSION_COOKIE];
		if (typeof value === "string" && value.length > 0) return { token: value, source: "cookie" };
	}

	return null;
}
