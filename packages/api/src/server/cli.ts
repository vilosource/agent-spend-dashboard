#!/usr/bin/env node
/**
 * Bin entry. Boots the Express app on the configured port.
 *
 * Kept tiny: the only IO is `loadConfig` (env reads) and `app.listen`.
 * Everything testable is in app.ts and config.ts.
 */

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const app = createApp({ publicUrl: cfg.publicUrl });

const server = app.listen(cfg.port, () => {
	// eslint-disable-next-line no-console
	console.log(`agent-spend-api listening on ${cfg.publicUrl}`);
});

// Graceful shutdown so docker compose / k8s send SIGTERM and we exit cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		// eslint-disable-next-line no-console
		console.log(`received ${signal}, shutting down`);
		server.close(() => process.exit(0));
		// Hard kill if shutdown drags
		setTimeout(() => process.exit(1), 5000).unref();
	});
}
