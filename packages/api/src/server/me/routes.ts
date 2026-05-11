/**
 * `/api/me/*` — own-data endpoints.
 *
 *   GET /api/me           identity probe (email, name, role, roles, oid)
 *   GET /api/me/usage     totals + per-day + per-model rollups
 *   GET /api/me/sessions  paginated session list (cursor pagination)
 *
 * All require `Authorization: Bearer <IdP access token>` via requireAuth.
 * Authorization is enforced in SQL via rowScope():
 *   - admin           → unrestricted
 *   - user / viewer   → own user_id only (= req.identity.email)
 *
 * The usage and sessions queries pass the rowScope SQL fragment +
 * params straight into Db; tests assert the right scope fires for
 * each role.
 */

import express, { type Request, type Response, type Router } from "express";
import type { Verifier } from "../auth/idp.js";
import { type Identity, requireAuth } from "../auth/middleware.js";
import { mergeWhere, rowScope } from "../auth/scope.js";
import type { Db } from "../db.js";

export interface MeRouteDeps {
	readonly db: Db;
	readonly verifier: Verifier;
}

const DEFAULT_RANGE_DAYS = 7;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function meRoutes(deps: MeRouteDeps): Router {
	const router = express.Router();
	const auth = requireAuth({ verifier: deps.verifier, db: deps.db });

	router.get("/me", auth, (req, res) => {
		const id = req.identity;
		if (!id) {
			res.status(500).json({ error: "identity not attached" });
			return;
		}
		res.json({
			email: id.email,
			name: id.name,
			role: id.role,
			roles: id.roles,
			oid: id.oid,
		});
	});

	router.get("/me/usage", auth, (req, res) => handleUsage(req, res, deps));
	router.get("/me/sessions", auth, (req, res) => handleSessions(req, res, deps));

	return router;
}

async function handleUsage(req: Request, res: Response, deps: MeRouteDeps): Promise<void> {
	const id = req.identity;
	if (!id) {
		res.status(500).json({ error: "identity not attached" });
		return;
	}
	const range = parseRange(req);
	if ("error" in range) {
		res.status(400).json({ error: range.error });
		return;
	}
	const where = buildScopedRange(id, range.from, range.to);
	const [totals, byDay, byModel] = await Promise.all([
		deps.db.fetchUsageTotals(where.sql, where.params),
		deps.db.fetchUsageByDay(where.sql, where.params),
		deps.db.fetchUsageByModel(where.sql, where.params),
	]);
	res.json({
		from: range.from.toISOString(),
		to: range.to.toISOString(),
		totals,
		byDay,
		byModel,
	});
}

async function handleSessions(req: Request, res: Response, deps: MeRouteDeps): Promise<void> {
	const id = req.identity;
	if (!id) {
		res.status(500).json({ error: "identity not attached" });
		return;
	}
	const range = parseRange(req);
	if ("error" in range) {
		res.status(400).json({ error: range.error });
		return;
	}
	const limit = clampLimit(req.query["limit"]);
	const cursor = decodeCursor(req.query["cursor"]);
	if (cursor === "invalid") {
		res.status(400).json({ error: "invalid cursor" });
		return;
	}
	const where = buildScopedRange(id, range.from, range.to);
	const items = await deps.db.fetchSessions({
		where: where.sql,
		params: where.params,
		limit: limit + 1, // fetch one extra so we know if there's a next page
		cursorLastTs: cursor?.lastTs ?? null,
		cursorSessionId: cursor?.sessionId ?? null,
	});
	const hasMore = items.length > limit;
	const page = hasMore ? items.slice(0, limit) : items;
	const last = page.at(-1);
	const nextCursor = hasMore && last ? encodeCursor(last.lastTs, last.sessionId) : null;
	res.json({
		from: range.from.toISOString(),
		to: range.to.toISOString(),
		items: page.map((s) => ({
			sessionId: s.sessionId,
			firstTs: s.firstTs.toISOString(),
			lastTs: s.lastTs.toISOString(),
			costUsd: s.costUsd,
			turns: s.turns,
			models: s.models,
		})),
		nextCursor,
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseRange(req: Request): { from: Date; to: Date } | { error: string } {
	const now = new Date();
	const fromQ = req.query["from"];
	const toQ = req.query["to"];
	const from = typeof fromQ === "string" ? new Date(fromQ) : new Date(now.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
	const to = typeof toQ === "string" ? new Date(toQ) : now;
	if (Number.isNaN(from.getTime())) return { error: "invalid ?from (expected ISO 8601)" };
	if (Number.isNaN(to.getTime())) return { error: "invalid ?to (expected ISO 8601)" };
	if (from > to) return { error: "?from must be <= ?to" };
	return { from, to };
}

function buildScopedRange(id: Identity, from: Date, to: Date): { sql: string; params: readonly unknown[] } {
	return mergeWhere(rowScope(id), "ts >= $1 AND ts <= $2", [from, to]);
}

function clampLimit(raw: unknown): number {
	if (typeof raw !== "string") return DEFAULT_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(n, MAX_LIMIT);
}

interface DecodedCursor {
	readonly lastTs: Date;
	readonly sessionId: string;
}

function encodeCursor(lastTs: Date, sessionId: string): string {
	const json = JSON.stringify({ t: lastTs.toISOString(), s: sessionId });
	return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): DecodedCursor | null | "invalid" {
	if (raw === undefined) return null;
	if (typeof raw !== "string" || raw.length === 0) return null;
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(json) as { t?: unknown; s?: unknown };
		if (typeof parsed.t !== "string" || typeof parsed.s !== "string") return "invalid";
		const ts = new Date(parsed.t);
		if (Number.isNaN(ts.getTime())) return "invalid";
		return { lastTs: ts, sessionId: parsed.s };
	} catch {
		return "invalid";
	}
}
