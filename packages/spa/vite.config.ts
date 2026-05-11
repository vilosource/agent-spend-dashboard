import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The Vite build outputs to packages/api/dist/spa/, which is what
 * Express serves via express.static() in production. The single-binary
 * single-port architecture from design §2.1 means there's no separate
 * SPA host: the API IS the SPA host.
 */
export default defineConfig({
	plugins: [svelte(), tailwind()],
	build: {
		outDir: "../api/dist/spa",
		emptyOutDir: true,
		assetsDir: "assets",
		sourcemap: true,
	},
	server: {
		// Local dev: Vite serves on a separate port. To exercise auth
		// flows during development, prefer building (`npm run -w
		// @vilosource/token-tracker-spa build`) and reloading the API,
		// or run the dev server with a manual proxy. Production is
		// always built + served by the API.
		port: 5173,
	},
});
