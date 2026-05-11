/**
 * `/v1/traces` — OTLP/HTTP traces ingest.
 *
 *   1. `Authorization: Bearer <IdP access token>`, verified by requireAuth.
 *   2. Parse OTLP body.
 *   3. Strip payload-shaped attributes (handled in transform.ts).
 *   4. For each span, build a row with user_id from the verified token —
 *      NOT from `agent.user.id` on the span (a forged-identity attempt is
 *      ignored). Skip spans missing required attrs (warn, don't fail).
 *   5. Return 200 `{"partialSuccess":{}}` per OTLP spec.
 *
 * Same verifier as `/api/*`; the CLI reporter sends a user access token
 * obtained via the device flow.
 */

import express, { type Request, type Response, type Router } from "express";
import type { Verifier } from "../auth/idp.js";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { type OtlpTracesPayload, payloadToRows, type TransformResult } from "./transform.js";

export interface IngestRouteDeps {
	readonly db: Db;
	readonly verifier: Verifier;
}

// Reasonable upper bound on the request body. Extensions flush per turn
// (typically <50 spans, each <2 KB of attributes), so 4 MB leaves a
// large safety margin without inviting a malicious sender to OOM us.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function ingestRoutes(deps: IngestRouteDeps): Router {
	const router = express.Router();
	const auth = requireAuth({ verifier: deps.verifier, db: deps.db });

	router.post(
		"/v1/traces",
		express.json({ limit: MAX_BODY_BYTES, type: ["application/json", "application/x-www-form-urlencoded"] }),
		auth,
		(req, res) => handleTraces(req, res, deps),
	);

	return router;
}

async function handleTraces(req: Request, res: Response, deps: IngestRouteDeps): Promise<void> {
	const email = req.identity?.email;
	if (!email) {
		res.status(500).json({ error: "identity not attached" });
		return;
	}

	const payload = parsePayload(req, res);
	if (!payload) return;

	const result = transformOrReject(payload, email, res);
	if (!result) return;

	if (!(await insertOrReject(deps.db, result, res))) return;

	respondPartialSuccess(res, result);
}

function parsePayload(req: Request, res: Response): OtlpTracesPayload | null {
	const payload = req.body as OtlpTracesPayload;
	if (typeof payload !== "object" || payload === null) {
		res.status(400).json({ error: "invalid OTLP payload (expected JSON object)" });
		return null;
	}
	return payload;
}

function transformOrReject(payload: OtlpTracesPayload, email: string, res: Response): TransformResult | null {
	try {
		return payloadToRows(payload, email);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		res.status(400).json({ error: `transform failed: ${msg}` });
		return null;
	}
}

async function insertOrReject(db: Db, result: TransformResult, res: Response): Promise<boolean> {
	try {
		await db.insertUsageLog(result.rows);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		res.status(500).json({ error: `insert failed: ${msg}` });
		return false;
	}
}

function respondPartialSuccess(res: Response, result: TransformResult): void {
	if (result.skipped > 0) {
		res.status(200).json({
			partialSuccess: {
				rejectedSpans: result.skipped,
				errorMessage: "spans missing required `agent.harness.name` attribute were skipped",
			},
		});
		return;
	}
	res.status(200).json({ partialSuccess: {} });
}
