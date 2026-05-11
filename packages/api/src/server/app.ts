/**
 * Express app factory.
 *
 * Per the design (§2.1), three URL spaces share one port:
 *   /              → SPA static bundle (Svelte 5; built into ../spa/)
 *   /health        → liveness probe
 *   /api/me*       → authenticated identity + own-data endpoints
 *   /auth/*        → OIDC login/callback/logout
 *   /v1/traces     → OTLP ingest (bearer-only, phase 0.3.7)
 *
 * The factory pattern keeps IO (`listen`, db connections, OIDC
 * discovery) separate from app construction so tests can wire a
 * fake `Db` and a real-Dex `OidcContext` independently.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { VERSION } from "../shared/version.js";
import type { OidcContext } from "./auth/oidc.js";
import { authRoutes } from "./auth/routes.js";
import type { Db } from "./db.js";
import { ingestRoutes } from "./ingest/routes.js";
import { meRoutes } from "./me/routes.js";
import { tokensRoutes } from "./me/tokens.js";

export interface AppDeps {
	readonly publicUrl: string;
	readonly jwtSecret: string;
	readonly oidc: OidcContext;
	readonly db: Db;
}

const SPA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../spa");

export function createApp(deps: AppDeps): Express {
	const app = express();
	app.disable("x-powered-by");

	app.get("/health", (_req: Request, res: Response) => {
		res.json({ status: "ok", version: VERSION });
	});

	app.use("/auth", authRoutes(deps));
	app.use(ingestRoutes({ db: deps.db, jwtSecret: deps.jwtSecret }));
	app.use("/api", meRoutes({ db: deps.db, jwtSecret: deps.jwtSecret }));
	app.use("/api", tokensRoutes({ db: deps.db, jwtSecret: deps.jwtSecret }));

	if (existsSync(SPA_DIR)) {
		// SPA bundle is present — serve it. Static assets first; any
		// other GET falls through to index.html so client-side
		// navigation to /me works on direct URL load.
		app.use(express.static(SPA_DIR, { index: false }));
		app.get(/^\/(?!api\/|auth\/|v1\/|health$|static\/).*/, (_req, res) => {
			res.sendFile(resolve(SPA_DIR, "index.html"));
		});
	} else {
		// SPA hasn't been built — surface a clear instruction instead of
		// a 404. This is the dev path before someone runs `npm run build`
		// in packages/spa, and the test path where createApp() is invoked
		// without a built bundle.
		app.get("/", (_req, res) => {
			res.set("Content-Type", "text/html; charset=utf-8");
			res.status(503).send(renderSpaMissing(deps.publicUrl));
		});
	}

	return app;
}

function renderSpaMissing(publicUrl: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Token Tracker</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 38em; margin: 4em auto; padding: 0 1em;">
<h1>Token Tracker</h1>
<p>The API is running but the SPA bundle isn't built yet.</p>
<p>From the repo root: <code>npm run -w @vilosource/token-tracker-spa build</code></p>
<p>Public URL: <code>${publicUrl}</code></p>
<p>API surface: <a href="/health"><code>/health</code></a> · <a href="/api/me"><code>/api/me</code></a></p>
</body></html>
`;
}
