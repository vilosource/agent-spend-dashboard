/**
 * `/api/me/tokens` — per-user machine token CRUD. Phase 0.3.10.
 *
 * GET    /me/tokens         list own active (non-revoked, non-expired) tokens
 * POST   /me/tokens         { label } → mint a 90d HS256 JWT, return ONCE
 * DELETE /me/tokens/:id     soft-revoke own token (404 if not yours)
 *
 * The minted JWT is the bearer token. We sha256(jwt) and store the digest
 * in api_tokens.token_hash (D14). The token row's expires_at matches the
 * JWT's exp claim; the auth middleware enforces both (signature check via
 * jose, lifecycle check via the partial-unique-index hot-path lookup).
 *
 * Authorization: requireAuth (cookie OR bearer). Self-only — no admin
 * cross-user revocation here; that lands with `/api/admin/*` in 0.3.11.
 *
 * The token is rendered to the response body of POST exactly once. There
 * is no endpoint that re-emits an existing token: lose it → revoke +
 * mint a new one.
 */

import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { SignJWT } from "jose";
import { requireAuth } from "../auth/middleware.js";
import { sha256Hex } from "../auth/tokens.js";
import type { Db, TokenListRow } from "../db.js";

export interface TokensRouteDeps {
	readonly db: Db;
	readonly jwtSecret: string;
}

const TOKEN_TTL_DAYS = 90;
const LABEL_MAX_LEN = 64;
// `length(label) > 0` is enforced by a CHECK constraint in 002_auth.sql,
// but we surface the same rule as a 400 instead of letting Postgres do it.
const LABEL_RE = /^[A-Za-z0-9._\-]+$/;

export function tokensRoutes(deps: TokensRouteDeps): Router {
	const router = express.Router();
	const auth = requireAuth({ db: deps.db, jwtSecret: deps.jwtSecret });
	// 4 KB is generous for `{ "label": "...64 chars max..." }`; rejects
	// any attempt to push large payloads through the auth-mint path.
	const json = express.json({ limit: "4kb" });

	router.get("/me/tokens", auth, (req, res) => handleList(req, res, deps));
	router.post("/me/tokens", auth, json, (req, res) => handleMint(req, res, deps));
	router.delete("/me/tokens/:id", auth, (req, res) => handleRevoke(req, res, deps));

	return router;
}

async function handleList(req: Request, res: Response, deps: TokensRouteDeps): Promise<void> {
	const userId = await resolveUserId(req, deps);
	if (userId === null) {
		res.status(500).json({ error: "user not found" });
		return;
	}
	const rows = await deps.db.listUserTokens(userId);
	res.json({ items: rows.map(toJson) });
}

async function handleMint(req: Request, res: Response, deps: TokensRouteDeps): Promise<void> {
	const id = req.identity;
	if (!id) {
		res.status(500).json({ error: "identity not attached" });
		return;
	}
	const label = parseLabel(req.body);
	if (typeof label !== "string") {
		res.status(400).json({ error: label.error });
		return;
	}
	const userId = await resolveUserId(req, deps);
	if (userId === null) {
		res.status(500).json({ error: "user not found" });
		return;
	}

	const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000);
	// `jti` makes every minted JWT unique even when claims + iat second match.
	// Without it, two mints in the same second produce the same hash and the
	// partial unique index on token_hash spuriously fires.
	const jwt = await new SignJWT({ email: id.email, name: id.name, role: id.role })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(id.email)
		.setJti(randomUUID())
		.setIssuedAt()
		.setExpirationTime(`${TOKEN_TTL_DAYS}d`)
		.sign(new TextEncoder().encode(deps.jwtSecret));

	try {
		const { id: tokenId } = await deps.db.insertApiToken({
			userId,
			label,
			tokenHash: sha256Hex(jwt),
			expiresAt,
		});
		res.status(201).json({
			id: tokenId,
			label,
			token: jwt,
			expiresAt: expiresAt.toISOString(),
		});
	} catch (err) {
		// idx_api_tokens_user_label_active is a partial unique index; if the
		// user already has an active token with this label, Postgres throws
		// 23505. Surface as 409 — the SPA can prompt for a different label.
		if (isUniqueViolation(err)) {
			res.status(409).json({ error: `a token with label '${label}' already exists` });
			return;
		}
		throw err;
	}
}

async function handleRevoke(req: Request, res: Response, deps: TokensRouteDeps): Promise<void> {
	const rawId = req.params["id"];
	const tokenId = Number.parseInt(typeof rawId === "string" ? rawId : "", 10);
	if (!Number.isFinite(tokenId) || tokenId <= 0) {
		res.status(400).json({ error: "invalid token id" });
		return;
	}
	const userId = await resolveUserId(req, deps);
	if (userId === null) {
		res.status(500).json({ error: "user not found" });
		return;
	}
	const ok = await deps.db.revokeApiTokenForUser(tokenId, userId);
	if (!ok) {
		// Either the id doesn't exist, isn't yours, or is already revoked.
		// All three look identical from the client side — don't leak which.
		res.status(404).json({ error: "not found" });
		return;
	}
	res.status(204).end();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `req.identity` to a numeric users.id. Bearer transport already
 * carries it; cookie transport carries email and we look it up. The
 * email→id query is one indexed seek on a small table (one row per
 * authenticated identity), fine for these low-frequency routes.
 */
async function resolveUserId(req: Request, deps: TokensRouteDeps): Promise<number | null> {
	const id = req.identity;
	if (!id) return null;
	if (id.userId !== null) return id.userId;
	return await deps.db.findUserIdByEmail(id.email);
}

function parseLabel(body: unknown): string | { error: string } {
	if (!body || typeof body !== "object") return { error: "body must be an object" };
	const raw = (body as Record<string, unknown>)["label"];
	if (typeof raw !== "string") return { error: "label must be a string" };
	const label = raw.trim();
	if (label.length === 0) return { error: "label is required" };
	if (label.length > LABEL_MAX_LEN) return { error: `label exceeds ${LABEL_MAX_LEN} chars` };
	if (!LABEL_RE.test(label)) return { error: "label may contain only letters, digits, '.', '_', '-'" };
	return label;
}

function toJson(r: TokenListRow): {
	id: number;
	label: string;
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string | null;
} {
	return {
		id: r.id,
		label: r.label,
		createdAt: r.createdAt.toISOString(),
		expiresAt: r.expiresAt.toISOString(),
		lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
	};
}

function isUniqueViolation(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
