/**
 * `/api/prices` — the model price reference table.
 *
 *   GET /api/prices   list every priced model + its list rate (USD per
 *                     1,000,000 tokens) + when prices were last synced.
 *
 * Reference data, not own-data — there's no rowScope here. It still
 * requires a valid TokenTracker.* token (requireAuth) so the surface
 * matches the rest of /api and the SPA can reuse its bearer.
 */

import express, { type Request, type Response, type Router } from "express";
import type { Verifier } from "../auth/idp.js";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";

export interface PricesRouteDeps {
	readonly db: Db;
	readonly verifier: Verifier;
}

export function pricesRoutes(deps: PricesRouteDeps): Router {
	const router = express.Router();
	const auth = requireAuth({ verifier: deps.verifier, db: deps.db });

	router.get("/prices", auth, (_req: Request, res: Response) => handlePrices(res, deps));

	return router;
}

async function handlePrices(res: Response, deps: PricesRouteDeps): Promise<void> {
	const prices = await deps.db.fetchModelPrices();
	res.json({
		updatedAt: prices.updatedAt,
		count: prices.items.length,
		items: prices.items,
	});
}
