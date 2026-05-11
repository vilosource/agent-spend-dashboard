#!/usr/bin/env node
/**
 * Bin entry. Boots the Express app on the configured port.
 *
 * IO is concentrated here: load env, connect Postgres, build the IdP
 * verifier (its discovery + JWKs fetch are lazy — on first authenticated
 * request — so boot doesn't depend on the IdP being reachable), then
 * hand a fully-wired set of deps to createApp.
 */

import { createApp } from "./app.js";
import { createVerifier } from "./auth/idp.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const cfg = loadConfig();

const db = createDb(cfg.databaseUrl);
const verifier = createVerifier(cfg.oidc);

const app = createApp({
	publicUrl: cfg.publicUrl,
	verifier,
	db,
});

const server = app.listen(cfg.port, () => {
	console.log(`token-tracker-api listening on ${cfg.publicUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.log(`received ${signal}, shutting down`);
		server.close(async () => {
			await db.close();
			process.exit(0);
		});
		setTimeout(() => process.exit(1), 5000).unref();
	});
}
