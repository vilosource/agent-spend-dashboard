/**
 * Express app factory.
 *
 * Per the design (§2.1), three URL spaces share one port:
 *   /              → SPA static bundle (placeholder for now)
 *   /health        → liveness probe
 *   /api/me        → authenticated identity probe (phase 0.3.3 minimal form)
 *   /auth/login    → start OIDC flow
 *   /auth/callback → finish OIDC flow, mint session cookie
 *   /auth/logout   → clear session cookie
 *   /v1/traces     → OTLP ingest (phase 0.3.7)
 *
 * The factory pattern keeps IO (`listen`, db connections, OIDC
 * discovery) separate from app construction so tests can wire a
 * fake `Db` and a real-Dex `OidcContext` independently.
 */

import express, { type Express, type Request, type Response } from "express";
import { VERSION } from "../shared/version.js";
import type { OidcContext } from "./auth/oidc.js";
import { authRoutes } from "./auth/routes.js";
import { readSession } from "./auth/session.js";
import type { Db } from "./db.js";

export interface AppDeps {
	readonly publicUrl: string;
	readonly jwtSecret: string;
	readonly oidc: OidcContext;
	readonly db: Db;
}

export function createApp(deps: AppDeps): Express {
	const app = express();
	app.disable("x-powered-by");

	app.get("/health", (_req: Request, res: Response) => {
		res.json({ status: "ok", version: VERSION });
	});

	app.use("/auth", authRoutes(deps));

	// Minimal `/api/me`: phase 0.3.3 ships just enough of an
	// authenticated probe to verify the session cookie carries identity.
	// The full /me page (with role + teams + last-seen) lands in 0.3.9.
	app.get("/api/me", async (req, res) => {
		const session = await readSession(req, deps.jwtSecret);
		if (!session) {
			res.status(401).json({ error: "unauthenticated" });
			return;
		}
		res.json({
			email: session.email,
			name: session.name,
			role: session.role,
		});
	});

	app.get("/", async (req: Request, res: Response) => {
		const session = await readSession(req, deps.jwtSecret);
		res.set("Content-Type", "text/html; charset=utf-8");
		res.send(renderPlaceholder(deps.publicUrl, session));
	});

	return app;
}

function renderPlaceholder(publicUrl: string, session: { email: string; role: string } | null): string {
	const authBlock = session
		? `<p>Logged in as <code>${htmlEscape(session.email)}</code> (role: <code>${htmlEscape(session.role)}</code>).
		   <form method="POST" action="/auth/logout" style="display:inline">
		      <button type="submit">Log out</button>
		   </form></p>`
		: `<p><a href="/auth/login">Log in</a> via the configured OIDC provider.</p>`;

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
   ${authBlock}
   <p>The SPA is not yet present in this build — it lands in phase 0.3.9.
      For now you can:</p>
   <ul>
      <li>Check liveness at <a href="/health"><code>/health</code></a></li>
      <li>Hit <a href="/api/me"><code>/api/me</code></a> to see the authenticated identity (or 401).</li>
      <li>Browse the <a href="https://github.com/vilosource/agent-spend-dashboard">project on GitHub</a></li>
   </ul>
   <p class="meta">This page served from <code>${htmlEscape(publicUrl)}</code>.</p>
</body>
</html>
`;
}

function htmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
