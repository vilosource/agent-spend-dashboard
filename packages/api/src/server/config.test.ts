import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
	it("returns defaults when env is empty", () => {
		const cfg = loadConfig({});
		expect(cfg.port).toBe(8080);
		expect(cfg.publicUrl).toBe("http://localhost:8080");
	});

	it("respects PORT", () => {
		const cfg = loadConfig({ PORT: "9999" });
		expect(cfg.port).toBe(9999);
		expect(cfg.publicUrl).toBe("http://localhost:9999");
	});

	it("respects PUBLIC_URL", () => {
		const cfg = loadConfig({ PUBLIC_URL: "https://dashboard.example.com" });
		expect(cfg.publicUrl).toBe("https://dashboard.example.com");
	});

	it("trims whitespace from PUBLIC_URL", () => {
		const cfg = loadConfig({ PUBLIC_URL: "  https://example.com  " });
		expect(cfg.publicUrl).toBe("https://example.com");
	});

	it("throws on non-numeric PORT", () => {
		expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/Invalid PORT/);
	});

	it("throws on out-of-range PORT", () => {
		expect(() => loadConfig({ PORT: "70000" })).toThrow(/Invalid PORT/);
		expect(() => loadConfig({ PORT: "0" })).toThrow(/Invalid PORT/);
	});
});
