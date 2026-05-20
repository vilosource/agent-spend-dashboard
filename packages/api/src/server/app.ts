/**
 * Express app factory.
 *
 * URL spaces sharing one port:
 *   /              → SPA static bundle (Svelte 5; built into ../spa/)
 *   /health        → liveness probe
 *   /api/me*       → authenticated identity + own-data endpoints
 *   /v1/traces     → OTLP ingest
 *
 * `/api/*` and `/v1/traces` require `Authorization: Bearer <IdP access
 * token>`; the server verifies it against the IdP's JWKs and issues
 * nothing itself. There is no `/auth/*` — the SPA does the OIDC dance
 * client-side (MSAL.js); the CLI uses the device flow.
 *
 * The factory pattern keeps IO (`listen`, db connections) separate from
 * app construction so tests can wire a fake `Db` and a `Verifier`
 * independently.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { VERSION } from "../shared/version.js";
import type { Verifier } from "./auth/idp.js";
import type { Db } from "./db.js";
import { ingestRoutes } from "./ingest/routes.js";
import { meRoutes } from "./me/routes.js";
import { pricesRoutes } from "./prices/routes.js";

export interface AppDeps {
	readonly publicUrl: string;
	readonly verifier: Verifier;
	readonly db: Db;
}

const SPA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../spa");

export function createApp(deps: AppDeps): Express {
	const app = express();
	app.disable("x-powered-by");

	// Baseline security headers on every response.
	//
	// `Permissions-Policy: local-network-access=(self)` is load-bearing:
	// `@azure/msal-browser`'s silent-auth iframe (the hidden frame it uses for
	// SSO / token renewal) sets `allow="local-network-access *"` on itself so
	// the embedded IdP page can probe a localhost single-sign-on broker — which
	// makes Chrome prompt the user "this page wants to access your other
	// devices". Capping `local-network-access` to `(self)` here means that
	// cross-origin delegation (to the `login.microsoftonline.com` iframe) is
	// denied, so the prompt never fires; the silent flow works fine without the
	// broker. `X-Frame-Options` must stay SAMEORIGIN, not DENY — that same MSAL
	// silent iframe briefly lands back on *this* origin during the handshake.
	// (A full Content-Security-Policy is a worthwhile addition per DESIGN §D3
	// but needs a vite.config tweak to drop the inline modulepreload polyfill
	// first; out of scope here.)
	app.use((_req: Request, res: Response, next: NextFunction) => {
		res.setHeader("Permissions-Policy", "local-network-access=(self)");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
		next();
	});

	app.get("/health", (_req: Request, res: Response) => {
		res.json({ status: "ok", version: VERSION });
	});

	app.use(ingestRoutes({ db: deps.db, verifier: deps.verifier }));
	app.use("/api", meRoutes({ db: deps.db, verifier: deps.verifier }));
	app.use("/api", pricesRoutes({ db: deps.db, verifier: deps.verifier }));

	if (existsSync(SPA_DIR)) {
		// SPA bundle is present — serve it. Static assets first; any
		// other GET falls through to index.html so client-side
		// navigation to /me works on direct URL load.
		app.use(express.static(SPA_DIR, { index: false }));
		app.get(/^\/(?!api\/|v1\/|health$|static\/).*/, (_req, res) => {
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
