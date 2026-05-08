/**
 * Express app factory.
 *
 * Per the design (§2.1), three URL spaces share one port:
 *   /          → SPA static bundle (placeholder for now)
 *   /health    → liveness probe
 *   /api/*     → REST (forthcoming)
 *   /auth/*    → OIDC (forthcoming)
 *   /v1/traces → OTLP ingest (forthcoming)
 *
 * For phase 0.3.1 only `/health` and a placeholder `/` exist.
 *
 * The factory pattern (rather than a global app) lets tests construct
 * isolated app instances without leaking state between tests, and it
 * keeps the IO (`listen`) separate from app construction so tests don't
 * need to bind ports.
 */

import express, { type Express, type Request, type Response } from "express";
import { VERSION } from "../shared/version.js";

export interface AppDeps {
	/** Public URL the API advertises. Used in the placeholder home page. */
	readonly publicUrl: string;
}

export function createApp(deps: AppDeps): Express {
	const app = express();

	// Disable x-powered-by header — small but standard hardening.
	app.disable("x-powered-by");

	app.get("/health", (_req: Request, res: Response) => {
		res.json({ status: "ok", version: VERSION });
	});

	app.get("/", (_req: Request, res: Response) => {
		res.set("Content-Type", "text/html; charset=utf-8");
		res.send(renderPlaceholder(deps.publicUrl));
	});

	return app;
}

/**
 * Placeholder home page rendered until the SPA bundle lands in phase 0.3.9.
 *
 * Pure: takes a string in, returns a string out. No IO, no template engine.
 * Lives here (in src/server/) rather than src/shared/ only because it's
 * server-rendered as part of the Express response, not a piece of pure
 * domain logic. If the page grows beyond a placeholder it should move to
 * its own module.
 */
function renderPlaceholder(publicUrl: string): string {
	return `<!doctype html>
<html lang="en">
<head>
   <meta charset="utf-8">
   <title>Agent Spend</title>
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <style>
      body { font-family: system-ui, sans-serif; max-width: 38em; margin: 4em auto; padding: 0 1em; color: #222; }
      code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
      .meta { color: #666; font-size: 0.9em; margin-top: 2em; }
   </style>
</head>
<body>
   <h1>Agent Spend</h1>
   <p>The reference dashboard server is running. Version <code>${VERSION}</code>.</p>
   <p>The SPA is not yet present in this build — it lands in phase 0.3.9.
      For now you can:</p>
   <ul>
      <li>Check liveness at <a href="/health"><code>/health</code></a></li>
      <li>Browse the <a href="https://github.com/vilosource/agent-spend-dashboard">project on GitHub</a></li>
      <li>See dashboards in Grafana at <a href="http://localhost:3000">localhost:3000</a> (when running the lab)</li>
   </ul>
   <p class="meta">This page served from <code>${publicUrl}</code>.</p>
</body>
</html>
`;
}
