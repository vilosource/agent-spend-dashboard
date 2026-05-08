#!/usr/bin/env node
/**
 * Bin entry. Boots the Express app on the configured port.
 *
 * IO is concentrated here: load env, connect Postgres, do OIDC
 * discovery, then hand a fully-wired set of deps to createApp.
 * Discovery failure is fatal — bad OIDC config should crash the
 * process, not silently 500 every login.
 */

import { createApp } from "./app.js";
import { configureOidc } from "./auth/oidc.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const cfg = loadConfig();

const db = createDb(cfg.databaseUrl);
const oidc = await configureOidc(cfg.oidc);

const app = createApp({
	publicUrl: cfg.publicUrl,
	jwtSecret: cfg.jwtSecret,
	oidc,
	db,
});

const server = app.listen(cfg.port, () => {
	console.log(`agent-spend-api listening on ${cfg.publicUrl}`);
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
