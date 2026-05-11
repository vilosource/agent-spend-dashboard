/**
 * `requireAuth` middleware.
 *
 * Every protected route (`/api/*`, `/v1/traces`) goes through here. The
 * server is a pure resource server (token-tracker-redesign-DESIGN.md §4.1):
 * one code path, `Authorization: Bearer <access_token>`, verified against the
 * IdP's JWKs. There is no cookie transport, no server-issued token, no
 * `api_tokens` table — the legacy split-on-transport design and its
 * shared-secret machinery are gone.
 *
 * Flow:
 *   1. extract the bearer token (401 "no token" if absent)
 *   2. verify it via the IdP verifier (401 "invalid token", or 503 if the IdP
 *      itself is unreachable)
 *   3. map the `roles` claim to an internal role; no role → 403 with a clear
 *      "ask an admin to add you" message (D7 — role lives in the token, not
 *      the DB; group-membership changes propagate on next token refresh)
 *   4. lazily upsert the `users` row (email/name/oid + last_seen_at); a write
 *      failure is logged, not fatal — the `users` row is bookkeeping, not a
 *      foreign-key target
 *   5. attach `req.identity` and continue
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "../db.js";
import { AuthError, type Verifier } from "./idp.js";

export type Role = "admin" | "user" | "viewer";

export interface Identity {
	readonly email: string;
	readonly name: string | null;
	readonly oid: string | null;
	/** Raw app-role claims from the token, for diagnostics / future fine-grained checks. */
	readonly roles: readonly string[];
	/** The mapped internal role (highest privilege wins if several are present). */
	readonly role: Role;
}

declare module "express-serve-static-core" {
	interface Request {
		identity?: Identity;
	}
}

const NO_ROLE_MESSAGE =
	"your account has no role assignment for this app — ask an admin to add you to the token-tracker users group";

export interface RequireAuthDeps {
	readonly verifier: Verifier;
	readonly db: Db;
}

export function requireAuth(deps: RequireAuthDeps): RequestHandler {
	return async (req: Request, res: Response, next: NextFunction) => {
		const token = bearerToken(req);
		if (!token) {
			reject(res, 401, "no token");
			return;
		}

		let verified: Awaited<ReturnType<Verifier["verifyAccessToken"]>>;
		try {
			verified = await deps.verifier.verifyAccessToken(token);
		} catch (err: unknown) {
			if (err instanceof AuthError && err.kind === "unavailable") {
				reject(res, 503, "authentication temporarily unavailable");
				return;
			}
			reject(res, 401, "invalid token");
			return;
		}

		const role = mapRole(verified.roles);
		if (!role) {
			reject(res, 403, NO_ROLE_MESSAGE);
			return;
		}

		try {
			await deps.db.upsertUser({ email: verified.email, name: verified.name, oid: verified.oid });
		} catch (err) {
			// Bookkeeping only — don't fail the request over it.
			console.error("upsertUser failed:", err);
		}

		req.identity = {
			email: verified.email,
			name: verified.name,
			oid: verified.oid,
			roles: verified.roles,
			role,
		};
		next();
	};
}

function mapRole(roles: readonly string[]): Role | null {
	if (roles.includes("TokenTracker.Admin")) return "admin";
	if (roles.includes("TokenTracker.User")) return "user";
	if (roles.includes("TokenTracker.Viewer")) return "viewer";
	return null;
}

function bearerToken(req: Request): string | null {
	const header = req.headers.authorization;
	if (typeof header === "string" && header.startsWith("Bearer ")) {
		const token = header.slice("Bearer ".length).trim();
		if (token.length > 0) return token;
	}
	return null;
}

function reject(res: Response, status: number, error: string): void {
	res.status(status).json({ error });
}
